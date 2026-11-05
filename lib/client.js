(function () {
  var BAR = "[data-windows-menu]"
  var ID_RELOAD = "dsh-quick-restart-reload"
  var ID_RESTART = "dsh-quick-restart-restart"
  // 样式照抄外壳菜单栏原生 button 规则。
  // 依据（从 app.asar 里挖出来的原文，lib/preload-app.cjs → installWindowsMenu）：
  //   :host { font-family: var(--dsw-font-family); ... }
  //   button { height:28px; padding:0 10px; border:0; border-radius:6px; background:transparent;
  //            color: var(--dsw-alias-label-secondary); font: inherit; font-size: 14px; cursor: default }
  // ⚠️ 2026-11-05 修：原来硬编码 font-size:13px，而原生是 14px → 用户一眼看出"和旁边的
  //    「应用」「编辑」不一样"。现在两项措施：① 这里逐条对齐原生（14px + font-family 变量）；
  //    ② matchNative() 在挂载时**从旁边真实原生按钮复制计算样式**，主题/字号/DPI 缩放再变也不会漂。
  var CSS = "height:28px;padding:0 10px;border:0;border-radius:6px;background:transparent;" +
    "color:var(--dsw-alias-label-secondary,inherit);font:inherit;" +
    "font-family:var(--dsw-font-family,inherit);font-size:14px;cursor:default;-webkit-app-region:no-drag"
  // 从菜单栏里第一个原生按钮上抄计算样式（在同一 shadow root 内，getComputedStyle 可用）。
  // 只抄视觉相关的、且非空的值；抄不到就保留上面的静态样式。
  var MATCH_PROPS = ["font-family", "font-size", "font-weight", "font-style", "letter-spacing",
    "line-height", "height", "min-height", "padding-left", "padding-right", "border-radius", "color"]
  function matchNative(bar, btn) {
    try {
      var native = null
      var kids = bar.children
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].tagName === "BUTTON") { native = kids[i]; break }
      }
      if (!native) return
      var cs = getComputedStyle(native)
      if (!cs) return
      for (var j = 0; j < MATCH_PROPS.length; j++) {
        var p = MATCH_PROPS[j]
        var v = cs.getPropertyValue(p)
        if (v) btn.style.setProperty(p, v)
      }
    } catch (e) { }
  }
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
  // 隐藏 dsh-hot-restart 自带浮动按钮的旧逻辑已删除（2026-11-05）：
  // ★ **不再隐藏原版那颗「热重启 dsh」**，两个入口并存。
  //
  // 原来会注入 `#dsh-hr-btn{display:none !important}` 把它藏掉，理由是"界面归拢到标题栏"。
  // 真机踩过两次坑之后改掉：我们的按钮依赖"宿主启动时一次性收集的注入表"，一旦这次没赶上
  // （例如插件是启动后热加载的），标题栏那颗就不会出现 —— 那时若又把原版浮动按钮藏着，
  // 用户**一个重启入口都没有**（2026-11-05 实际发生过，只能靠托盘/任务管理器）。
  // 原版浮动按钮走 dsh-hot-restart 自己的注册路径，更早更稳；两者点下去是同一个引擎。
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
  function makeButton(bar, id, text, kind) {
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
    // 挂上去之前先对齐旁边原生按钮的计算样式（字号/字体/内边距/高度等）
    matchNative(bar, b)
    return b
  }
  function mount() {
    var bar = menuBar()
    if (!bar) return false
    hoverStyle(bar)
    if (bar.querySelector("#" + ID_RELOAD)) return true
    bar.appendChild(makeButton(bar, ID_RELOAD, "重载插件", "reload"))
    bar.appendChild(makeButton(bar, ID_RESTART, "重启", "restart"))
    return true
  }
  var tries = 0
  // 不再动 dsh-hot-restart 的浮动按钮（见文件上方说明）：只负责挂我们这两颗。
  var timer = setInterval(function () { tries += 1; if (mount() || tries > 240) clearInterval(timer) }, 500)
  mount()
})();
