(function () {
  var BAR = "[data-windows-menu]"
  var ID_RELOAD = "dsh-quick-restart-reload"
  var ID_RESTART = "dsh-quick-restart-restart"
  // 样式照抄外壳菜单栏原生 button 规则（app.asar lib/preload-app.cjs: installWindowsMenu）
  var CSS = "height:28px;padding:0 10px;border:0;border-radius:6px;background:transparent;" +
    "color:var(--dsw-alias-label-secondary,inherit);font-family:inherit;font-size:13px;" +
    "font-weight:400;line-height:28px;cursor:default;-webkit-app-region:no-drag"
  function menuBar() {
    try {
      var hosts = document.querySelectorAll(BAR)
      for (var i = 0; i < hosts.length; i++) {
        var shadow = hosts[i].shadowRoot
        if (!shadow) continue
        var bar = shadow.querySelector("[role=menubar]")
        if (bar) return bar
      }
    } catch (e) { }
    return null
  }
  // 隐藏 dsh-hot-restart 自带的浮动按钮（我们只借用它的重启引擎，界面用标题栏这颗）
  function hideTheirs() {
    try {
      var id = "dsh-hot-restart-hide"
      if (document.getElementById(id)) return
      var st = document.createElement("style")
      st.id = id
      st.textContent = "#dsh-hr-btn{display:none !important}"
      ;(document.head || document.documentElement).appendChild(st)
    } catch (e) { }
  }
  function hoverStyle(bar) {
    try {
      var root = bar.getRootNode()
      if (!root || typeof root.querySelector !== "function") return
      if (root.querySelector("#dsh-quick-restart-hover")) return
      var st = document.createElement("style")
      st.id = "dsh-quick-restart-hover"
      st.textContent = "#" + ID_RELOAD + ":hover,#" + ID_RESTART + ":hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18)) !important;color:var(--dsw-alias-label-primary,inherit) !important}"
      ;(root.nodeType === 11 ? root : (document.head || document.documentElement)).appendChild(st)
    } catch (e) { }
  }
  function fire(kind, btn, text) {
    btn.disabled = true
    btn.textContent = kind === "reload" ? "重载中…" : "重启中…"
    function done(msg) { btn.textContent = msg; setTimeout(function () { btn.textContent = text; btn.disabled = false }, 4000) }
    if (kind === "reload") {
      fetch("/dsh-quick-restart/reload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || "failed")
          var list = j.result || []
          var bad = list.filter(function (x) { return !x.ok })
          if (bad.length) { btn.title = bad.map(function (b) { return b.pkg + ": " + b.error }).join("\n") }
          done(bad.length ? ("失败 " + bad.length + "/" + list.length) : ("已重载 " + list.length + " 个"))
        })
        .catch(function (e) { done("失败: " + String((e && e.message) || e)) })
      return
    }
    // 重启：借 dsh-hot-restart 的引擎（vbs 助手，已验证过）
    fetch("/dsh-hot-restart/restart", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-dsh-hot-restart": "1" },
      body: JSON.stringify({ at: Date.now(), ua: navigator.userAgent })
    })
      .then(function (r) { return r.json().catch(function () { return {} }).then(function (j) { return { ok: r.ok, j: j } }) })
      .then(function (x) {
        if (!x.ok || !x.j || x.j.ok !== true) throw new Error((x.j && x.j.error) || "HTTP")
        btn.textContent = "重启中…"
      })
      .catch(function (e) { done("失败: " + String((e && e.message) || e)) })
  }
  function makeButton(id, text, kind) {
    var b = document.createElement("button")
    b.type = "button"
    b.id = id
    b.setAttribute("role", "menuitem")
    b.tabIndex = -1
    b.setAttribute("style", CSS)
    b.textContent = text
    b.title = kind === "reload" ? "重载插件代码，不动主进程" : "关闭并重开 DSH（dsh-hot-restart 引擎）"
    b.addEventListener("pointerdown", function (e) { e.preventDefault() })
    b.addEventListener("mousedown", function (e) { e.preventDefault() })
    b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); fire(kind, b, text) })
    return b
  }
  function mount() {
    hideTheirs()
    var bar = menuBar()
    if (!bar) return false
    hoverStyle(bar)
    if (bar.querySelector("#" + ID_RELOAD)) return true
    bar.appendChild(makeButton(ID_RELOAD, "重载插件", "reload"))
    bar.appendChild(makeButton(ID_RESTART, "重启", "restart"))
    return true
  }
  var tries = 0
  var timer = setInterval(function () { tries += 1; hideTheirs(); if (mount() || tries > 240) clearInterval(timer) }, 500)
  mount()
})();
