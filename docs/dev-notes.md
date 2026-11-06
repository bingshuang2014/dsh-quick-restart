# 开发档案 / Dev Notes

> 这里是**维护者视角**的内部细节：缺陷根因、cordis 内部原理、上游版本比对、实测方法、结论适用范围。
> 只想用插件的话看 [README](../README.md) 就够了。

---

## 目录

- [上游版本谱系（逐字节比对）](#上游版本谱系逐字节比对)
- [本 fork 的版本线](#本-fork-的版本线)
- [四个热重载缺陷的根因与修法](#四个热重载缺陷的根因与修法)
- [三处独立验证推翻的方案](#三处独立验证推翻的方案)
- [为什么需要平台事务这一级引擎](#为什么需要平台事务这一级引擎)
- [宿主的 7 条注册冲突原文](#宿主的-7-条注册冲突原文)
- [响应形状与字段含义](#响应形状与字段含义)
- [已知行为变化：import.meta.url 带 query](#已知行为变化importmetaurl-带-query)
- [怎么判断真的修好了（可观测标记对照实验）](#怎么判断真的修好了可观测标记对照实验)
- [CSRF 加固的实测记录](#csrf-加固的实测记录)
- [结论适用范围（哪条结论基于哪份代码）](#结论适用范围哪条结论基于哪份代码)
- [桌面壳注入通道的限制](#桌面壳注入通道的限制)
- [让「保存文件即生效」的配置](#让保存文件即生效的配置)

---

## 上游版本谱系（逐字节比对）

本仓库是 [`bingshuang2014/dsh-quick-restart`](https://github.com/bingshuang2014/dsh-quick-restart) 的**本地 fork**（上游原作者 [`a994903574/dsh-quick-restart`](https://github.com/a994903574/dsh-quick-restart)），基线是 0.1.1，版本号自 0.1.2 起。

从 npm 拉原始 tarball 逐字节比对的结果：

| 版本 | `lib/index.js` | 相对 0.1.1 的增量 |
|---|---|---|
| 0.1.1 | 7,215 B | —（基线） |
| 0.1.2 | 7,215 B | **无**（与 0.1.1 逐字节相同） |
| 0.1.3 | 8,081 B | 仅新增 `embedHotRestart` 函数**定义**（**从未被调用**）+ `dependencies: { dsh-hot-restart: ^0.3.16 }` |
| 0.1.4 | 8,081 B | 与 0.1.3 逐字节相同（latest） |

也就是说：**上游三个版本加起来只多了"一段没人调用的函数 + 一条依赖声明"，没有其它功能进展；而 junction 修复与缓存击穿两条（①②）上游至今都没有。** 本 fork 是在这个基线上补的 ①②③④ 与三处收敛，功能上是 0.1.4 的超集（唯一没搬的是那段未调用的 `embedHotRestart`）。

## 本 fork 的版本线

| 版本 | 提交 | 内容 |
|---|---|---|
| 0.1.2 | `7a9d848`…`92c4160` | 修四个热重载缺陷（①②③④）+ 三处误删收敛 + 失败不再谎报成功 + 去 BOM |
| 0.1.3 | `bfc9aed` | 「重载」优先走平台第一方事务（`hmr.reconcileProfile()`）；两级引擎 + 自动退回 |
| 0.2.0 | `4289679` | 修按钮文案读错响应形状（原本会谎报「已重载 0 个」）；版本线正式离开上游 0.1.x |
| 0.2.1 | `296ec7c` | 修 CSRF：`POST /reload` 加自定义头 + 同源双闸（原本任意网页都能触发重载） |

> 为什么跳 0.2.0：重载引擎换了（不再纯手工操作 registry），且要跟 npm 上的 0.1.4 在视觉上分清。同一个 0.1.x 号段已经被上游三个几乎没区别的版本用掉了。

## 四个热重载缺陷的根因与修法

修的是**热重载静默失效**：接口返回 `{"ok":true}`，代码却根本没换。两个独立缺陷叠在一起：

| 缺陷 | 位置 | 现象 | 修法 |
|---|---|---|---|
| ① 前缀对不上 | `lib/index.js` `invalidateDir` | 用 `fileURLToPath(url)` 拿到的是 **profile 里的 junction 路径**，而 `loader.internal.loadCache` 的 key 是 Node 解析后的**真实路径**，前缀不匹配 → 一条都清不掉（实测 `cleared = 0`）→ `loader.import` 命中缓存返回旧模块 | 先用 `realpathSync` 解析 junction 再算前缀 |
| ② 引擎级缓存 | `lib/index.js` `reloadOne` | 即使 `loadCache` 清干净（实测 `cleared = 31`），Node 的 **ESM 模块表**（引擎级 ModuleMap）对同一个 `file:` URL 第二次 `import` 直接返回缓存模块 | `loader.import` 的 URL 追加 `?dshReload=<ts>`，每次 URL 都不同 |
| ③ 同一个包**只能重载一次** | `lib/index.js` `reloadOne` | 第一次重载生效，之后每次接口都返 `{"ok":true,...,"cleared":31}`，但服务端代码**永远停在第一次那份**（实测 `MARK_V1 → 写 V2 重载 → 仍 V1 → 写 V3 重载 → 仍 V1`） | 见下 |
| ④ apply 异常被吞 | `lib/index.js` `reloadOne` | `registry.plugin()` 返回 **thenable**，不 `await` 就永远看不到 `apply()` 的失败 | `await Promise.race([Promise.resolve(fiber), setTimeout(5000)])`；失败则回滚 |

缺陷③ 的根因在 cordis 内部（`@deepseek-ai/cordis` `src/registry.ts`）：registry 的 `_internal` 是 **`Map<callback, Runtime>`**（key 是插件回调身份），只有 `delete(plugin)` 会 `fiber.dispose()`——而**每次重载 `import` 出的都是新模块 → 新 callback**，loader entry 里那个 fiber 只对应**第一次**加载的 runtime。于是第二次重载 `delete` 的是早已删掉的旧 runtime（no-op），**上一次重载实例的 fiber 永远不会被 dispose**，它注册的原生工具 / persona section / HTTP 路由一直挂着，新实例 `apply()` 走到注册那一段就撞名抛错；而 cordis 是异步跑 `apply` 的，**异常被吞掉** → 又是一层 `ok:true` 的假成功。

修法：自己记住「上一次重载注册进去的那个 plugin 对象」（`swapped: Map<包名, plugin>`），下次重载先把**它**（连同 entry 里那个）从 registry 删掉，再注册新的。

回滚路径（缺陷④的配套）：`registry.delete(newPlugin)` 卸下半成品 → `registry.plugin(entryPlugin, ...)` 把旧的装回去 → throw，让失败可见。

## 三处独立验证推翻的方案

都能复算（离线最小实验，不依赖真机）：

| 现象 | 原因 | 处理 |
|---|---|---|
| 重载 `A` 会连 `A-old` / `A.bak` / `A-deep` 的缓存一起清（实测清 6 条，本包只有 3 条） | 上游第一道清理 `k.indexOf(prefix) >= 0` 是纯子串匹配，**没有路径边界**（上游原有，不是本 fork 引入） | 前缀匹配加边界：`k === prefix \|\| k.indexOf(prefix + '/') >= 0` |
| URL 指向不存在的文件时，清理范围会放大到**整个祖先工程目录**（实测 17 条 key 全灭） | `package.json` 向上查找一路走到祖先工程的 `package.json`；而 `loader.import` 随后必然失败，清缓存毫无意义 | 文件不存在就直接 `return 0`，不再向上走 |
| 「前缀没命中时按父目录名松匹配」的兜底会**误删跨盘同名包**的缓存（反例已确证：`<另一个盘符>:/otherplace/<同名包>/...`） | 松匹配串（`/base/`、`/base.`）没有任何路径范围约束；而这个兜底在本机的 junction 部署里从不需要触发 | **不采用**（原本是可选方案，验证后删掉） |

顺带把失败暴露出来：`reloadOne` 现在返回 `{ cleared }`，`reloadTargets` 把它透出到响应里。
**上游只报 `ok`/`error`，于是「清 0 条 = 其实没重载」被显示成成功** —— 这个 bug 能活这么久，就是因为失败被报成了成功。

## 为什么需要平台事务这一级引擎

「重载」不是只有一种做法，本插件分两级：

| 优先级 | 引擎 | 触发条件 | 行为 |
|---|---|---|---|
| 1 | **平台第一方** `@deepseek-ai/dsh-hmr` 的 `reconcileProfile()` | 默认（POST body 不带 `packages`） | 比对磁盘 → 停 loader entry（真 dispose）→ `recomposeProfile()` → 用新文件重启 entry → 判定激活。**账目一致、无孤立注册、无 `restart-required`** |
| 2 | 本地（本项目自有实现） | `ctx.hmr` 不可用 / 平台事务抛错 / 显式点名 `{"packages":[...]}` | `registry.delete(旧)` + `import(带缓存击穿)` + `registry.plugin(新)`，精确控制「只重载这几个包」 |

为什么要有第 1 级——**宿主自己把根因说出来了**（见下节）。那 7 个正是被本地路径换过的那 7 个包。也就是说：**本地那条路径会把旧实例的注册留在原地**（工具名 / prompt 段 / 服务 / 路由前缀），旧 fiber 从未被 dispose；而平台一碰上这些残留就判 `restart-required`。**插件管理器显示"未运行"是同一件事的另一面**（`fiberPhase: null`）。第 1 级引擎从根上避开它。

平台事务的核心调用（`ctx.hmr` 是 `@deepseek-ai/dsh-hmr` 注册的服务）：

```js
await hmr.runReload(() => hmr.reconcileProfile())
```

`runReload(op)` 内部是 `runExclusive(async () => { if (await this.applicationReady) await op() })`，保证不与其它重组合并发。`reconcileProfile()` 要求：必须在 `runExclusive` 事务内、必须有 `profileContext`，否则抛错。

## 宿主的 7 条注册冲突原文

2026-11-05 用插件管理器触发一次重组合时，宿主逐条报出（插件名已泛化，其余为原文）：

```
browser  (<plugin-i>):  tool "<tool-c>" is already registered
<plugin-a> (<plugin-a>): prompt section "<section-a>" is already registered
bot      (<plugin-b>):       prompt section "<section-b>" is already registered
<plugin-c>  (<plugin-c>):      service "<service-a>" has been registered at <pet>
<plugin-d>:              webserver: duplicate prefix route "/<plugin-d>"
<plugin-e>:             tool "<tool-b>" is already registered
<plugin-f>:       service "<service-b>" has been registered
→ application: "restart-required"
```

宿主自己给出的修法原文：

```
(for a per-agent override, register through that agent's agent.ctx instead)
```

**这直接指向了插件编写规范：`apply()` 必须可重入** —— 注册工具/prompt 段/服务/路由前要先释放旧注册，或走 per-agent `ctx` 通道，否则平台替换（HMR / recompose）也会失败。

## 响应形状与字段含义

`POST /dsh-quick-restart/reload` 的响应：

```json
// 默认：走平台第一方事务（2026-11-06 起）
{ "ok": true, "engine": "platform", "warnings": [], "pending": [] }

// 平台不可用 / 失败时自动退回本地路径（原因如实带回，不假装成功）
{ "ok": true, "engine": "local", "fellBack": "平台事务失败: ...", "result": [ ... ], "summary": { "total": 12, "failed": 0 } }

// 点名重载（仍走本地路径）
{ "ok": true, "engine": "local", "result": [ { "pkg": "<plugin-a>", "ok": true, "cleared": 31 } ], "summary": { "total": 1, "failed": 0 } }
```

- `summary.failed > 0` 就是**真的有包没换成功**——这是「假成功」的拦截点。
- `restartReason`（平台认为必须重启的原因）有值就说明有些改动不是热重载能覆盖的。
- `warnings` 是注册冲突/未激活诊断，逐条列出。
- `pending` 是仍需下次刷新页面才换成新版的模块数。

## 已知行为变化：import.meta.url 带 query

击穿引擎级缓存必须换 URL，代价是：**被重载模块里的 `import.meta.url` 会带上 `?dshReload=<ts>`**。

- `fileURLToPath(import.meta.url)` 仍然正常（会剥掉 query）；
- 相对依赖**不会**被复制成两份（实测：同一实例，Node 会归一化相对说明符）；
- 但**任何把 `import.meta.url` 拿去做字符串拼接／比较的插件会看到多出来的 query**。本插件自己的 `HERE` 走 `fileURLToPath`，不受影响。

## 怎么判断真的修好了（可观测标记对照实验）

`ok: true` 只代表没抛异常。唯一可信的是**可观测标记对照实验**，而且**必须连续做 3 次**——「同一个包只能重载一次」那个缺陷只在第二次以后暴露：

1. 在目标插件里加一处可观测的标记（例如它的 health 路由返回值里加一行 `reloadMark: 'M1'`）；
2. 重载**之前**先读一次接口 → 应看不到该标记；
3. `POST /dsh-quick-restart/reload` `{"confirm":true,"packages":["<包名>"]}`；
4. 再读一次 → 标记**出现**了才算真的重载成功（没出现就还有第三层缓存）；同时看响应里的 `cleared`：`cleared: 0` 说明缺陷① 没修好；`cleared > 0` 但标记没变说明缺陷② 或 ③ 没修好；
5. **把标记改成 `M2`（再写 `M3`），重复第 3–4 步**：每次重载后标记都必须跟着变。若第一次变了、后面不变，就是缺陷③（旧实例的 fiber 没被 dispose，新实例撞名抛错被异步吞掉）——**这时接口仍然返回 `ok:true` 与 `cleared>0`**；
6. 验证完立刻删掉那个标记，并再重载一次恢复原状。

## CSRF 加固的实测记录

**0.2.0 及以前**：`POST /dsh-quick-restart/reload` **没有任何校验**。实测连 `Content-Type: text/plain` 这种「简单请求」都直接执行重载——而简单请求**不触发 CORS 预检**，于是任意网页都能往 `127.0.0.1:<port>` 打一发，让你的插件全部重载一轮。

**0.2.1 起**：`fenceError()` 在**读 body 之前**执行两道闸（① 自定义头 `x-dsh-quick-restart: 1`；② 同源校验：`Origin.host` == `Host`、`Sec-Fetch-Site` 须为 `same-origin`/`none`、拒绝 `Origin: null`）。

六个攻击向量的实测输出：

```
无自定义头 text/plain              → 403 缺少 x-dsh-quick-restart: 1 请求头
无自定义头 application/json        → 403 同上
有头 + Origin: http://evil.example → 403 拒绝跨源请求（Origin evil.example ≠ Host 127.0.0.1:<port>）
有头 + Origin: null                → 403 拒绝 Origin: null 的请求
有头 + Sec-Fetch-Site: cross-site  → 403 拒绝跨站请求
头值写成 0                          → 403 缺少 x-dsh-quick-restart: 1 请求头
```

正常路径不受影响：带头 + 同源 → `200 {"ok":true,"engine":"platform",...}`；`confirm` 缺失仍是 `400`（说明 fence 已过、进入业务校验）。

`GET /dsh-quick-restart/info` 只查同源、**不要求自定义头**——它是探活接口，加头会让 `curl` 和地址栏都发不出去，也就失去了「路由是否活着」的用途。

**这道闸的边界**：防的是「**网页**替我发请求」，不防「**本机进程**替我发请求」。后者挡不住也不该挡——能起本地进程的话，早就能直接改你的插件文件了。

## 结论适用范围（哪条结论基于哪份代码）

**先说清楚：本仓库永远只维护 fork 这一份代码；上面全部结论都基于 fork，不是 npm 上的版本。**

历史上确实有多份代码同时存在过，结论容易张冠李戴，所以逐条标注：

| 结论 | 依据的代码 | 适用范围 / 注意 |
|---|---|---|
| 「重启 DSH」靠内嵌 `embedHotRestart` 拉起 `dsh-hot-restart` | npm **0.1.4**（本机那份 12,941 B；2026-11-05 14:34 被就地打过补丁） | **只对那一份成立**。本 fork 没有该内嵌逻辑，重启能力靠 `dsh-hot-restart` 作为独立 bundle 加载 |
| 「`embedHotRestart` 定义了但从未被调用（上游 issue #1）」 | 上游 0.1.4 的源码状态 | **与本机不符**：本机那份已被就地补上调用（注释日期 2026-11-03）。跨版本引用时别用这条 |
| 四个缺陷（junction 前缀 / ESM ModuleMap / 同包只能重载一次 / apply 异常被吞） | 本 fork rev1→rev5 + `@deepseek-ai/cordis` 4.0.1 源码 + 真机实测 | 适用本 fork。npm 0.1.4 **同样有**「同包只能重载一次」和「apply 异常被吞」两处（它也没 `await`）；所以"0.1.4 是好的"只指它的**重启**按钮，不是它的重载 |
| 「平台 `@deepseek-ai/dsh-hmr` 已覆盖上面四个缺陷」 | `app.asar` 里 `dsh-hmr@0.2.2-rc.1` 的 README + 抽出的 `lib/index.js`（61 KB） | 适用**该版本**；换 host 版本要重新确认 |
| 「删掉本插件不影响重启能力」 | 实测（退役后 `/dsh-hot-restart/restart` 仍 401）+ bundle 元数据 | 适用当前 profile 布局：`dsh-hot-restart` 有自己的 `dependencies` 与 `dsh.profile.bundles` 条目 |
| 「改 `dsh.profile.bundles` → 平台 hmr 会自动重组合」 | 实测两次 | **不对称**：移除（同时删 junction）会当场自动卸载；加回（先改 manifest、后建 junction）会因"那一刻文件还不存在"落到 `failed` 且**不自动重试**，需要再触发一次重组合（`plugin_manager set_bundle(false→true)`）。判定时看时点 |
| 「上游 0.1.2–0.1.4 比 0.1.1 更完善」 | npm 四个版本的 pristine tarball（逐字节比对） | **基本不成立**：0.1.2=0.1.1、0.1.3=0.1.4=0.1.1 + 一段未调用的 `embedHotRestart` + 一条依赖声明 |
| 「本机那份 12,941 B 的 `npm 0.1.4`」 | 上游 0.1.4（8,081 B）+ 约 4,860 B **本机就地补丁** | 它**已被我们改过**（补丁含 embed 的调用、①②、兜底、早抛），不是上游原样；引用它做对比时务必声明 |
| 「重启按钮可用」的两种实现 | 实测 + 元数据 | 上游 0.1.3+ 的做法是**内嵌自举**（`import('dsh-hot-restart')`）；本 fork 不改代码，改由 `dsh-hot-restart` 作为 profile 的独立 bundle 提供。两者结果一致，后者在 `link:` 部署下才成立（裸 import 会从 fork 的 realpath 找 node_modules，找不到 profile 那份） |

## 桌面壳注入通道的限制

桌面壳的 `index.html` 直接读安装包里的静态 dist，不走 `renderIndex`，所以 `webServer.tapIndex` 无效。
唯一可用的通道是宿主启动时**一次性收集**的 `webserver/index-inject` 注入表——所以插件里不能写对象级 `inject = ['webServer']`，
否则 `apply()` 会推迟到 webServer 就绪之后，错过那次收集，界面上永远看不到按钮。这一点已在代码注释里写明。

重载本身是：取 loader 的 entries → 清掉该包在 `loader.internal.loadCache` 里的模块 → 重新 import → 用新插件替换旧的 fiber。

## 让「保存文件即生效」的配置

平台 HMR 默认 `root: []`（= 不监听源码），所以「改完代码不生效」是**默认行为**。要开自动重载，在 profile 的 `cordis.patch.yml` 加：

```yaml
- id: hmr
  name: "@deepseek-ai/dsh-hmr"
  config:
    base: "file:///D:/你的插件父目录"    # ← 必须给；必须是 file:// URL
    root:
      - "D:/你的插件真身目录"            # 写 link: 目标的真身，不是 profile/node_modules 里的 junction
    ignored:                             # ← 必须给；必须写成反斜杠形式
      - '**\\node_modules'
      - '**\\node_modules\\**'
      - '**\\.*'
      - '**\\.*\\**'
```

四个实测要点：

- **必须重启一次才生效** —— `root` / `base` 是 HMR 插件在**自己加载时**读的；而且 `include:hmr` 被系统锁定（管理器返回 `management-required`，不能热开关）。
- **默认 `ignored` 含 `**/node_modules`**，所以别写 junction 路径，要写 `link:` 指向的真实目录。
- **`base` 少了会让整件事静默失效**，且零日志 —— 见下节，这是最坑的一条。
- **`ignored` 必须写成反斜杠形式**，否则 Windows 下默认那几条**一条都匹配不上**。

### 为什么 `base` 是必须的（静默失效的根因）

`dsh-hmr` 的 ignored 回调是：

```js
ignored: (path) => picomatch(ignored)(relative(watchBaseDir, path))
```

`watchBaseDir` 默认取 `config.base`；不配就是 `dsh-hmr` 自己的目录（在 `app.asar` 里）。
而 `root` 是绝对路径 → 两者不在同一棵树下 → `relative()` 算出 `..\..\..\0data\...` 这种串。
picomatch 把 `.` 开头的段当隐藏文件，默认 `ignored` 里的 **`**/.*`** 一条就命中它。

**于是文件在 chokidar 层就被 ignored 掉，`changed` 集合永远为空，`dispatch` 提前 return —— 连一行 warn 都不打。**
这就是「配了、看着也对，但保存完全没反应，也不报错」的全部原因。

补上 `base` 之后又有个连带坑：`relative()` 这时返回 Windows 原生**反斜杠**路径，而 picomatch 不把 `\`
当分隔符（`picomatch(['**/node_modules'])('a\\node_modules') === false`），默认 `ignored` 会**全部失效**，
watcher 转头去监听整个 `node_modules` 和 `.git` —— 所以必须显式写反斜杠版。

另外 `base` **不能写纯路径**：`new URL('D:/x', baseUrl)` 会解析成 `d:/x`（无 scheme），
`fileURLToPath()` 随后抛 `ERR_INVALID_URL_SCHEME`，插件启动直接失败。要么 `file:///D:/...`，
要么相对 `ctx.baseUrl` 的 `../..` 链。

### 实测结论（2026-11-06 收尾，已线上验收）

改一个字符串后 **+1.1 秒**接口返回值就变，进程 pid **不变**（桌面窗口不动）—— 这正是要的「窗口不变、插件更新」。

定位办法：从 `app.asar` 抽出与宿主**同版本**的 chokidar 5.0.0 + picomatch，在独立进程里 1:1 复刻 `configure()`，
跑 A/B 对照。旧配置（无 `base`）4 个探针目录收到 **0 条 change**；新配置 **4/4 全部收到**，且 `node_modules` 探针被正确忽略。
旧配置的表现与线上「保存无任何反应」完全吻合。

> ⚠️ 本节历史版本两次写错：先写「改 `lib/index.js` → 2 秒内生效，全程没点按钮」（无证据，已作废），
> 后更正为「没测出效果、根因未找到」。**两次都不准确** —— 真相是配置缺 `base` 导致 HMR 从未被触发，现已修复。
> 完整排查记录见 `HMR排查交接.md`（该文件含本机路径，不随包发布）。

