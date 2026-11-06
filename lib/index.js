// dsh-quick-restart — 宿主侧：注入标题栏脚本 + 两条路由（重载 / 重启）
// 关键：**不写对象级 inject**。桌面端（Electron）的注入表是宿主启动时一次性收集的
// （collectIndexInjections → IPC → 渲染层逐行应用），对象级 inject 会把 apply() 推迟到
// webServer 就绪之后，订阅晚于那次收集，界面就永远不出现。
// 另外：桌面壳的 index.html 从安装包静态 dist 读盘，不经过 renderIndex()，tapIndex 无效；
// 唯一通道是 webserver/index-inject 的结构化 script 行。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'

export const name = 'dsh-quick-restart'

const HERE = dirname(fileURLToPath(import.meta.url))
const SELF = 'dsh-quick-restart'
const CLIENT_ROUTE = '/dsh-quick-restart/client.js'
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
// 内联加载器：自己建 <script src> 并吞掉 onerror —— 路由在就加载，不在也不影响页面启动
const LOADER = 'var s=document.createElement("script");s.src="' + CLIENT_ROUTE + '";s.onerror=function(){};document.body.appendChild(s);'

function pkgOf(spec) {
  if (!spec) return null
  const parts = String(spec).split('/')
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

// ★ 2026-11-06 本地修复 bug ②b：**缓存击穿的 query 必须贯穿整个依赖图**
//
// 症状（本轮实测出来的）：给 entry 的 URL 加了 `?dshReload=<ts>`，接口报
//   {"ok":true,"engine":"local","result":[{"pkg":"<plugin-a>","ok":true,"cleared":31}]}
// `cleared:31` 说明第一层（loadCache）清干净了，**但入口模块内部 import 的
// 相对依赖全都还是旧实例** —— 于是出现最诡异的现象：
//   · `plugin/index.js` 是**新的**（响应里出现了只有新版才有的 `host.probe` 字段）
//   · `plugin/lib/host-version.js` 是**旧的**（同一响应里 `host.detected` 走的还是
//     旧逻辑，报 `lock-range` 而不是 asar 精确版本）
//   **一个包里新旧代码各一半** —— 这比"全旧"更难发现，因为新字段出现会让人
//   以为"重载成功了"。
//
// 根因（Node 原生最小实验，别重推）：
//   写 V1 → import(main) 得 M1/V1 → 改 main 与 dep 为 V2 → import(main+'?t=')
//   → **main=M2 但 dep 仍是 V1**。
//   即：query 只作用于你 import 的那一个 URL，**相对说明符 `./dep.js` 由 Node
//   自己解析、不会继承父模块的 query**，于是依赖树里除入口外全是老模块。
//
// 修法：注册一个 resolve hook，把父模块 URL 上的 `?dshReload=` 传播给子模块。
//   · 只传播给**相对/绝对/file: 说明符**；裸模块名（`node:fs`、`some-pkg`）不动 ——
//     那些要是被复制成两份实例，单例语义就破了（比"没换代码"更糟）。
//   · 只在父 URL 带 query 时接管，平时是零开销的直通。
// 实测（本机 Node v25，三层依赖链 main→dep→deeper）：改三个文件后 import 带 query
//   的入口，得到 M2/V2/D2 —— 全树都换了。
//
// 兼容性：`registerHooks` 是 Node 22.15+ / 23.5+ 的同步 API。拿不到就如实降级为
//   原来的"只换入口"行为，并在响应里说明（**不能假装成功**）。
let propagateState = 'unknown'
function ensureQueryPropagation() {
  if (propagateState !== 'unknown') return propagateState
  if (typeof registerHooks !== 'function') { propagateState = 'unavailable'; return propagateState }
  try {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const r = nextResolve(specifier, context)
        const m = /[?&]dshReload=(\d+)/.exec(context.parentURL || '')
        if (!m) return r
        if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) return r
        if (typeof r.url !== 'string' || !r.url.startsWith('file:') || r.url.includes('dshReload=')) return r
        return { ...r, url: r.url + (r.url.includes('?') ? '&' : '?') + 'dshReload=' + m[1] }
      },
    })
    propagateState = 'ok'
  } catch (e) {
    log('缓存击穿 hook 注册失败（降级为只换入口模块）: ' + String((e && e.message) || e))
    propagateState = 'error'
  }
  return propagateState
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) } })
  })
}

function json(res, code, obj) {
  try { res.writeHead(code, JSON_HEADERS); res.end(JSON.stringify(obj)) } catch { /* 忽略 */ }
}

export function apply(ctx, config = {}) {
  try { applyInner(ctx, config) } catch (e) {
    try { ctx.logger?.error?.('dsh-quick-restart 装载失败: ' + String((e && e.stack) || e)) } catch { /* 忽略 */ }
  }
}

function applyInner(ctx, config = {}) {
  const appExe = config.appExe || process.execPath
  const log = (m) => { try { ctx.logger?.info?.(m) } catch { /* 忽略 */ } }
  let port = 0
  const webPort = () => { try { if (Number.isSafeInteger(ctx.webServer?.port)) return ctx.webServer.port } catch { /* 忽略 */ } return port }

  // ① 注入表（必须尽早订阅，且不能依赖 webServer）
  try {
    ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      if (table.some((row) => row && typeof row.text === 'string' && row.text.indexOf(CLIENT_ROUTE) >= 0)) return
      table.push({ kind: 'script', placement: 'body', text: LOADER })
    })
  } catch (e) { log('index-inject 订阅失败: ' + String((e && e.message) || e)) }

  function resolveUrl(internal, specifier, parentURL) {
    const attrs = {}
    if (internal.version === 'v2' && typeof internal.resolveSync === 'function') return internal.resolveSync(parentURL, { specifier, attributes: attrs })
    if (typeof internal.resolve === 'function') return internal.resolve(specifier, parentURL, attrs)
    if (typeof internal.resolveSync === 'function') return internal.resolveSync(parentURL, { specifier, attributes: attrs })
    throw new Error('loader.internal 没有解析器')
  }

  function invalidateDir(internal, url) {
    // ★ 2026-11-05 本地修复 bug ①：junction / link 部署下热重载静默失效
    //
    // 症状：POST /dsh-quick-restart/reload 返回 {"ok":true}，日志也显示 apply 重新跑了，
    //       但**加载的是旧代码**（实测：health 里新加的字段不出现）。
    //
    // 根因：`dirname(fileURLToPath(url))` 拿到的是 **profile 里的 junction 路径**
    //       （C:\Users\<user>\.dsh\profiles\desktop\node_modules\<plugin-a>），
    //       而 `internal.loadCache` 的 key 是 **Node 解析后的真实路径**
    //       （<你的工作区>\Z-agents\plugin\lib\xxx.js）。
    //       前缀对不上 → 一条都删不掉（实测 cleared = 0）→ `loader.import(url)` 命中缓存
    //       → 返回旧模块 → 表面「重载成功」，实际什么都没换。
    //
    // 影响面：凡是 `link:` / junction / symlink 装的插件全都热重载不了。
    //       npm 正常安装（真目录）不受影响，所以上游没发现这个 bug。
    //
    // 修法：先用 realpathSync 把 junction 解析成真实路径，再算前缀；
    //       解析失败退回原逻辑（保持旧行为，不因解析异常而少清缓存）。
    // 另补一道边界（独立验证实测出来的放大面）：**目标文件不存在时直接不清**。
    //       上游逻辑在这种情况下会一路向上找到**祖先工程目录**的 package.json
    //       （实测：URL 指向不存在的文件时 17 条 key 全灭，连别的包一起清），
    //       而 loader.import 随后必然失败 —— 清缓存毫无意义，返回 0 让失败可见。
    let file
    try {
      file = realpathSync.native(fileURLToPath(url))
    } catch {
      try { file = fileURLToPath(url) } catch { return 0 }
      if (!existsSync(file)) return 0
    }
    let dir = dirname(file)
    let root = null
    for (;;) {
      if (existsSync(join(dir, 'package.json'))) { root = dir; break }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    const prefix = root ? root.replace(/\\/g, '/').toLowerCase() : null
    let n = 0
    try {
      for (const key of [...internal.loadCache.keys()]) {
        const k = String(key).replace(/\\/g, '/').toLowerCase()
        // ★ 前缀匹配必须带**路径边界**（独立验证实测出来的放大面）：
        //   原来的 `k.indexOf(prefix) >= 0` 是纯子串匹配，于是重载 `linkplug`
        //   会连 `linkplug-extra` / `linkplug.bak` / `linkplug-deep` 的缓存一起清掉
        //   （实测 return=6，本包自己只有 3 条）。这里要求「同目录」或「以 / 续接」。
        if (prefix ? (k === prefix || k.indexOf(prefix + '/') >= 0) : false) { try { Map.prototype.delete.call(internal.loadCache, key); n += 1 } catch { /* 忽略 */ } }
      }
    } catch { /* 忽略 */ }
    return n
  }

  // ★ 2026-11-05 本地修复 bug ③：**同一个包只能重载一次**（第二次以后是静默空转）
  //
  // 定位依据（源码级，@deepseek-ai/cordis src/registry.ts）：
  //   · `_internal` 是 `Map<callback, Runtime>`（:197），key 是**插件回调的身份**；
  //   · `delete(plugin)` 才会 `fiber.dispose()`（:258-267）——即「释放注册」的唯一入口；
  //   · 每次重载 import 出来的是**新模块实例 → 新 callback**，
  //     而 loader entry 里那个 fiber 只对应**第一次**加载的 runtime。
  // 于是：第一次重载删掉的是原始 runtime（其 fiber 被 dispose，工具/persona/路由都释放）→
  // 新实例能干净地 apply 完（实测服务端代码确实换成新的）；
  // 第二次重载删的仍是那个早已删掉的旧 runtime（no-op），**上一次重载实例的 fiber 永远
  // 不会被 dispose**，它的注册一直挂着 → 新实例 apply 到一半撞名抛错，而 cordis 是异步
  // 跑 apply 的，异常被吞掉 → 接口照样 `ok:true` + `cleared:N`。
  // 这就是又一层「假成功」：真机实测 `MARK_V1 → 改成 V2 再重载 → 仍是 V1`。
  //
  // 修法：自己记住「上一次重载注册进去的那个 plugin 对象」，下次先把**它**从 registry
  // 删掉（连同 entry 里那个一起删），再注册新的。
  const swapped = new Map()

  async function reloadOne(loader, internal, entry) {
    const specifier = entry?.options?.name
    const pkg = pkgOf(specifier)
    const parentURL = entry?.parent?.tree?.ctx?.baseUrl ?? ctx.baseUrl
    const entryFiber = entry?.fiber
    const entryPlugin = entryFiber?.runtime?.callback
    const lastPlugin = pkg ? swapped.get(pkg) : null
    if (!entryPlugin && !lastPlugin) throw new Error('没有活动的 fiber')
    const resolved = await resolveUrl(internal, specifier, parentURL)
    const url = typeof resolved === 'string' ? resolved : (resolved && resolved.url ? String(resolved.url) : String(resolved))
    // 非 file: 的模块（内置 / 虚拟）没有磁盘文件可换：早点报清楚，
    // 不要让 fileURLToPath 在 invalidateDir 里抛「URL must be of scheme file」那种怪错。
    if (!/^file:/i.test(url)) throw new Error(`非 file: 模块无法热重载: ${url.slice(0, 120)}`)
    const cleared = invalidateDir(internal, url)
    // ★ 2026-11-05 本地修复 bug ②：再给 import URL 加**缓存击穿参数**
    //
    // 实测：清完 cordis 的 loadCache（cleared = 31）后再重载，接口返回 ok，
    //       但新代码依然没加载。第二层缓存是 **Node 的 ESM 模块表**（引擎级 ModuleMap）：
    //       同一个 `file:` URL 第二次 import 会**直接返回缓存模块**，清 loadCache 碰不到它。
    //
    // 独立最小实验（Node 原生）：
    //   写入 V1 → import(url) 得 V1 → 改文件为 V2 → 再 import(url) **仍得 V1**
    //   → 换成 import(url + '?t=<ts>') 才拿到 V2
    //
    // 所以必须让每次重载的 URL 都不同。加 query 不影响 file: 解析。
    //
    // ★ 已知行为变化（独立验证实测，必须写明，别信「不影响 import.meta.url」这种话）：
    //   被重载模块里的 `import.meta.url` 会带上 `?dshReload=<ts>`。
    //   · `fileURLToPath(import.meta.url)` 仍然正常（会剥掉 query）—— 我们自己的 HERE 就走这条；
    //   · 相对依赖**不会**被复制成两份（实测：同一实例，Node 会归一化相对说明符）；
    //   · 但**任何把 import.meta.url 拿去做字符串拼接/比较的插件会看到多出来的 query**。
    //   这是击穿引擎级缓存必须付的代价：不清就没法换代码，而「静默不换代码」是更坏的结果。
    const urlNoQuery = url.split('?')[0]
    const bustUrl = `${urlNoQuery}?dshReload=${Date.now()}`
    // 先保证 hook 就位：没有它的话只有入口模块会被换掉，依赖全留在旧实例上。
    // ★ 这个返回值必须如实带回给调用方 —— 「只换入口」看起来几乎和成功一样
    //   （新字段会出现），是本轮最会骗人的一种半成功。
    const propagation = ensureQueryPropagation()
    const newPlugin = loader.unwrapExports(await loader.import(bustUrl, () => []))
    if (!newPlugin) throw new Error('重新 import 没有导出插件')
    // registry 挂在 entry 那个 fiber 的父 context 上（就是根 ctx）；取不到就退回 ctx.registry
    const registry = entryFiber?.parent?.registry ?? ctx.registry
    if (!registry) throw new Error('registry 不可用')
    // 两个都要删：entry 里那个（第一次重载时是原始实例）+ 我们上次注册的那个
    // （第二次以后，真正还活着的就是它）。Set 去重避免首次重载重复删。
    for (const old of new Set([entryPlugin, lastPlugin])) {
      if (!old) continue
      try { registry.delete(old) } catch { /* 已经没了就算了 */ }
    }
    // 配置：优先取 loader entry 上的 config，退回旧 fiber 的 _config
    // （entryFiber 缺失时 _config 就没了，会把插件配置弄丢 —— 独立验证 D3 指出的副作用）
    const fiberConfig = entry?.options?.config ?? entryFiber?._config
    // ★ 2026-11-05 本地修复 bug ④ 的一半：**必须 await registry.plugin(...) 的返回值**
    //
    // registry.plugin() 返回的是 thenable（@deepseek-ai/cordis src/registry.ts:331-334），
    // `await` 它才走 fiber.await() —— 而 **fiber.await() 会把 apply 抛出的异常重新抛出来**
    // （src/fiber.ts 的 await 实现）。不 await 的话，apply 里任何失败只进 logger，
    // 接口照旧返回 ok:true：缺陷④ 能藏这么久、以及"改了代码没生效却报成功"，
    // 根子都在这里。四版代码（含上游）都没 await —— 这一条是独立验证用真实 cordis 库实测出来的。
    //
    // 但不能无限等：若新实例声明的服务依赖一直不满足，fiber 会停在加载中。
    // 所以给 5 秒上限：超时按"已注册、仍在加载"放过（不谎报失败），
    // 抛错则**如实失败**，并尽力把旧实例装回去（否则这个包就下线了）。
    let fiber
    try {
      fiber = registry.plugin(newPlugin, fiberConfig, () => [])
      await Promise.race([
        Promise.resolve(fiber),
        new Promise((resolve) => { const t = setTimeout(resolve, 5000); t.unref?.() }),
      ])
    } catch (e) {
      // 失败处理（顺序很重要，独立验证用真实 cordis 实测出来的）：
      //   ① 先把**半成品的新实例**从 registry 删掉 —— 否则它的 fiber 会以 FAILED 状态
      //      留在注册表里（entries 累加），它没释放干净的注册（工具名等）会污染
      //      下一次重载的报错：本该报「新代码自身有错」，却变成「工具名已被占用」。
      //   ② 再把旧实例装回去，尽量不把这个包弄下线。
      //   ③ 最后如实抛出（接口返回 ok:false），绝不再吞成 ok:true。
      try { registry.delete(newPlugin) } catch { /* 忽略 */ }
      try {
        if (entryPlugin && entryPlugin !== newPlugin) registry.plugin(entryPlugin, fiberConfig, () => [])
      } catch { /* 回滚失败也只能如实报错 */ }
      throw new Error('新实例 apply 失败（已卸下半成品并尝试回滚旧实例）: ' + String((e && e.message) || e))
    }
    if (pkg) swapped.set(pkg, newPlugin)
    // ★ 改动 3：把「清了几条缓存」带回去。
    //   上游只报 ok/error，于是「清 0 条 = 其实没重载」这种失败会被显示成成功 ——
    //   这个 bug 能活这么久，就是因为失败被报成了成功。
    // ★ 2026-11-06：再带上 `propagation`（依赖图是否也跟着换了）。
    //   `cleared:31` 只证明清了 cordis 的缓存，**不证明依赖模块被换掉**。
    return { cleared, propagation }
  }

  // ★ 2026-11-06：**优先走平台第一方事务**（@deepseek-ai/dsh-hmr）
  //
  // 为什么必须加这条：我们自己的重载是 `registry.delete(旧) + registry.plugin(新)`，
  // 它**只删 callback，不 dispose loader entry 上的 fiber**，于是旧实例的注册
  // （工具名 / prompt 段 / 服务 / 路由前缀）会一直挂着。这不是我推的：
  // 宿主机自己在一次 recompose 里逐条报了出来 ——
  //   tool "<tool-c>" is already registered（<plugin-i>）
  //   prompt section "<section-a>" is already registered（<plugin-a>）
  //   service "<service-a>" has been registered at <pet>（<plugin-c>）
  //   duplicate prefix route "/<plugin-d>"（dsh-<plugin-d>）
  //   tool "<tool-b>" is already registered（<plugin-e>）
  //   prompt section "<section-b>" is already registered（<plugin-b>）
  //   service "<service-b>" has been registered（<plugin-g>/redteam）
  // 并且判成 `application: restart-required` —— 与插件管理器里显示「未运行」
  // （fiberPhase: null）是同一件事的两面。
  //
  // 平台自己的做法不有这个问题：hmr 的 `reconcileProfile()` 会比对磁盘 →
  // 停掉 loader entry（真 dispose）→ recomposeProfile → 用新文件重启 entry →
  // 判定激活，账目天然一致。所以：**没有点名 packages 时走平台事务**，
  // 点名时（`{packages:[...]}`）仍走我们这条精确控制的路径（用于单独救一个包）。
  //
  // 失败退回：ctx.hmr 不存在（平台没开 HMR）或事务抛错时，退回老路径，并把原因带回去。
  async function reloadViaPlatform() {
    const hmr = ctx.get('hmr')
    if (!hmr || typeof hmr.runReload !== 'function') return { ok: false, error: 'hmr 服务不可用（平台未启用 @deepseek-ai/dsh-hmr）' }
    try {
      const r = await hmr.runReload(() => hmr.reconcileProfile())
      return { ok: true, engine: 'platform', warnings: (r && r.warnings) || [], pending: (r && r.pending) || [], restartReason: r && r.restartReason }
    } catch (e) {
      return { ok: false, error: '平台事务失败: ' + String((e && e.message) || e) }
    }
  }

  async function reloadTargets(only) {
    const loader = ctx.get('loader')
    const internal = loader?.internal
    if (!loader || typeof loader.entries !== 'function') throw new Error('loader 不可用')
    if (!internal || !internal.loadCache) throw new Error('loader.internal 不可用，无法清缓存')
    const seen = new Set()
    const out = []
    for (const entry of [...loader.entries()]) {
      if (entry?.disabled || entry?.options?.group || !entry?.fiber?.runtime) continue
      const pkg = pkgOf(entry?.options?.name)
      if (!pkg || pkg === SELF) continue
      // 宿主内置插件（@deepseek-ai/*）在 app.asar 里，热重载必然失败，别去碰
      if (pkg.startsWith('@deepseek-ai/')) continue
      if (pkg.startsWith('cordis:')) continue // 虚拟分组条目，没有可重载的模块
      if (only && only.length && !only.includes(pkg)) continue
      if (seen.has(pkg)) continue
      seen.add(pkg)
      try { const r = await reloadOne(loader, internal, entry); out.push({ pkg, ok: true, cleared: r.cleared, propagation: r.propagation }) }
      catch (e) { out.push({ pkg, ok: false, error: String((e && e.message) || e) }) }
    }
    return out
  }

  // ★ 2026-11-06 安全加固：CSRF fence（与 dsh-hot-restart 的做法对齐）
  //
  // 问题（实测出来的，不是推测）：
  //   `POST /dsh-quick-restart/reload` 原本**没有任何校验**，连
  //   `Content-Type: text/plain` 这种「简单请求」都直接执行重载 —— 而简单请求
  //   **不触发 CORS 预检**，于是任意网页都能往 127.0.0.1:<port> 打一发，
  //   让全部插件重载一轮（噪音骚扰、打断正在进行的重载）。
  //   对照：dsh-hot-restart 的 /restart 有同样的 fence，无头请求实测 401。
  //
  // 两道闸：
  //   ① **必须带自定义头** `x-dsh-quick-restart: 1`。
  //      自定义头会让跨站请求从「简单请求」变成「非简单请求」→ 浏览器先发
  //      OPTIONS 预检 → 本服务不认 → 真正的 POST 根本发不出去。
  //      同源页面**不需要预检**，所以按钮那条路径一点不受影响。
  //   ② **同源校验**：Origin 的主机必须等于 Host；Sec-Fetch-Site 存在时必须
  //      是 same-origin / none（挡掉 Origin: null 的沙箱 iframe 与 file:// 页面）。
  //
  // 注意：非浏览器客户端（curl / 本地脚本）不送 Origin，只靠①把门 —— 这是
  // 有意的，否则本机调试得先伪造 Origin。
  // 这道闸防的是「网页替我发请求」，不防「本机进程替我发请求」（那个层面
  // 挡不住也不该挡：能起本地进程的话，早就能直接改文件了）。
  const FENCE_HEADER = 'x-dsh-quick-restart'
  function fenceError(req) {
    const h = (req && req.headers) || {}
    if (String(h[FENCE_HEADER] || '') !== '1') return '缺少 ' + FENCE_HEADER + ': 1 请求头'
    const site = h['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') return '拒绝跨站请求（Sec-Fetch-Site: ' + site + '）'
    const origin = h.origin
    if (origin) {
      if (origin === 'null') return '拒绝 Origin: null 的请求（沙箱 iframe / file:// 页面）'
      let host = ''
      try { host = new URL(origin).host } catch { return 'Origin 格式无法解析: ' + origin }
      if (host !== (h.host || '')) return '拒绝跨源请求（Origin ' + host + ' ≠ Host ' + (h.host || '') + '）'
    }
    return null
  }

    // ② 路由（等 webServer）
  ctx.inject(['webServer'], (c) => {
    try { port = Number(c.webServer?.port) || 0 } catch { /* 忽略 */ }
    const route = (path, handler) => c.effect(() => c.webServer.register({ kind: 'exact', path, handler }))
    route(CLIENT_ROUTE, (req, res) => {
      try {
        const js = readFileSync(join(HERE, 'client.js'), 'utf8')
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(js)
      } catch (e) { res.writeHead(404); res.end('missing client') }
    })
    // /info 也加同源闸（2026-11-06）：它会暴露 pid 与端口。
    // 但它**不能**要求自定义头 —— 它是 GET 探活接口，加头会让 curl/浏览器地址栏都发不出去，
    // 也失去了「路由是否活着」这个用途。所以这里只查同源，不查 fence 头。
    route('/dsh-quick-restart/info', (req, res) => {
      const h = (req && req.headers) || {}
      const site = h['sec-fetch-site']
      if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { ok: false, error: '跨站请求' })
      const origin = h.origin
      if (origin && origin !== 'null') {
        try { if (new URL(origin).host !== (h.host || '')) return json(res, 403, { ok: false, error: '跨源请求' }) } catch { /* 解析不了就放过，info 本身无副作用 */ }
      }
      return json(res, 200, { ok: true, name: SELF, pid: process.pid, port: webPort(), engine: 'platform-first' })
    })
    route('/dsh-quick-restart/reload', async (req, res) => {
      // fence 先于一切：连 body 都不读就拒掉，别给跨站请求做无用功
      const denied = fenceError(req)
      if (denied) {
        try { ctx.logger?.warn?.('quick-restart 拒绝未授权的 reload: ' + denied) } catch { /* 忽略 */ }
        return json(res, 403, { ok: false, error: denied })
      }
      const b = await readBody(req)
      if (b.confirm !== true) return json(res, 400, { ok: false, error: '需要 confirm:true' })
      const only = Array.isArray(b.packages) ? b.packages : null
      try {
        // 没点名 = 「把所有能换的都换一轮」→ 交给平台事务（账目一致、无孤立注册）
        if (!only || !only.length) {
          const viaPlatform = await reloadViaPlatform()
          if (viaPlatform.ok) {
            const payload = { ok: true, engine: viaPlatform.engine, warnings: viaPlatform.warnings, pending: viaPlatform.pending, restartReason: viaPlatform.restartReason }
            log('quick-restart 重载(平台): ' + JSON.stringify(payload))
            return json(res, 200, payload)
          }
          // 平台不可用/失败 → 退回本地路径，但把原因如实带回去（不假装成功）
          log('quick-restart 平台重载失败，退回本地: ' + viaPlatform.error)
          const result = await reloadTargets(null)
          const failed = result.filter((r) => !r.ok)
          return json(res, 200, { ok: true, engine: 'local', fellBack: viaPlatform.error, result, summary: { total: result.length, failed: failed.length } })
        }
        const result = await reloadTargets(only)
        const failed = result.filter((r) => !r.ok)
        log('quick-restart 重载: ' + JSON.stringify(result))
        return json(res, 200, { ok: true, engine: 'local', result, summary: { total: result.length, failed: failed.length } })
      } catch (e) { return json(res, 500, { ok: false, error: String((e && e.message) || e) }) }
    })
  })
}