# dsh-quick-restart 问题排查报告

> 提交给插件作者的问题清单。所有结论都标注了**证据来源**；凡是没验证的都明确写「未验证」。
>
> 排查环境：DeepSeek Harness `0.2.2-rc.1`（Electron 44.7.0）、Windows。
> 本机环境标识（宿主端口、第三方插件名与其资源名）已匿名化为 `<PORT>`、`<pkg-a>` 这类占位符；
> 错误模板本身的原文保持不变，因为它才是要修的东西。
> 本 fork 代码基线是上游 `0.1.1`（`package.json` 的 `_upstream.baseVersion`）；功能上是 npm `0.1.4` 的超集，
> 曾把 4 个 npm tarball（0.1.1→0.1.4）拉下来逐字节比对，见 `package.json` 的 `_upstream.npmLineage`。
> 本 fork 版本 `0.2.2`。以下问题**均已在本机真实宿主上复现**，不是静态推断。
> 「证据强度」列写的是我实际做到哪一步：**宿主源码**=逐行读过被依赖包的实现；**真机复现**=在运行的宿主上调接口实测。
> 行号引用均以本 fork `0.2.2`（`lib/index.js` 共 442 行）为准，上游行号会偏移。

---

## 摘要（先看这张表）

| # | 问题 | 严重度 | 是否已修 | 证据强度 |
|---|---|---|---|---|
| 1 | `reloadOne()` 不 `await` fiber 卸载 → 新旧实例注册窗口重叠 | **高**（热重载随机失败） | 未修 | 宿主源码 + 真机复现 |
| 2 | 平台事务 `reconcileProfile()` 在「重复 apply」场景下必然失败，且失败信息误导 | 中（功能可用但每次报假警报） | 未修（已定位到机制） | 真机复现 3 次 |
| 3 | `reloadViaPlatform()` 的返回值把「7 个包失败」压成一个字符串，无法程序化处理 | 中（排障靠肉眼读字符串） | 未修 | 代码 + 响应实测 |
| 4 | 不点名重载时**静默 fallback**，调用方看不出「平台事务失败过」 | 中（掩盖问题） | 部分（有 `fellBack` 字段） | 响应实测 |
| 5 | `?dshReload=` query 会让插件的 `import.meta.url` 带上参数 | 低（已知副作用，已写注释） | 已记录未修 | 独立实验 |
| 6 | README 与实际行为不符（多处） | 低 | 未修 | 文档比对 |
| 7 | **平台 HMR 在 Windows 下静默失效**（`root` 配绝对路径且未配 `base`） | **高**（「保存即生效」完全不可用，且零日志） | 配置层已绕过，**框架层未修** | 宿主源码 + A/B 对照 + 线上验收 |

---

## 问题 1（最严重）：`reloadOne()` 不等旧 fiber 卸完就注册新实例

### 现象

连续两次点名重载同一个包，第二次可能报：

```
prompt section "xxx:persona" is already registered
tool "xxx_yyy" is already registered
webserver: duplicate exact route "/xxx"
```

同一条重载，**有时成功有时失败**，没有稳定规律 —— 这是典型的竞态特征。

### 根因（逐层扒到宿主源码）

**第一层**：`reloadOne()` 里的删除是同步调用、不等结果

`lib/index.js:234-237`：

```js
for (const old of new Set([entryPlugin, lastPlugin])) {
  if (!old) continue
  try { registry.delete(old) } catch { /* 已经没了就算了 */ }
}
```

**第二层**：`registry.delete()` 确实会 dispose fiber，但**不等待**

宿主 `app.asar` 里 `Registry.delete` 的原文：

```js
delete(plugin) {
  const key = this.resolve(plugin);
  const runtime = key && this._internal.get(key);
  if (!runtime) return;
  this._internal.delete(key);
  for (const fiber of runtime.fibers) fiber.dispose();   // ← 返回值被丢弃
  return runtime;
}
```

JSDoc 写的是 *"Dispose every running fiber for a plugin and remove its runtime record"* —— 意图是对的，`fiber.dispose()` 也确实被调用了。

> **回源方式**（可复现）：从 `app.asar` 用 asar 头部布局取文件，上面这段是
> `/dsh/node_modules/@deepseek-ai/cordis/src/registry.ts` 的**逐字原文**，不是转述。
> 同一份源码在 asar 里有两处（`/node_modules/` 和 `/dsh/node_modules/`），内容一致。

**第三层**：`fiber.dispose()` 返回的是 **Promise**

宿主 `app.asar` 里 `Fiber` 类的字段声明（`fiber.ts` L194，逐字）：

```ts
/** Dispose this fiber: unload the plugin, then settle once cleanup finished. */
public readonly dispose: () => Promise<void>
```

注释自己就写着 *"then settle once cleanup finished"* —— 它知道这是异步的，但 `delete()` 里没 `await`。

**第四层**：于是 `reloadOne()` 紧接着就注册新实例

`lib/index.js:254`：

```js
fiber = registry.plugin(newPlugin, fiberConfig, () => [])
```

**此时旧实例的 effect undo（注销路由 / 工具 / prompt 段 / 服务）可能还没执行完**，新实例 `apply()` 一注册就撞名。

### 为什么这个解释可信

宿主 `@deepseek-ai/cordis-plugin-loader` 里有段注释明确列出了这个场景
（`app.asar` → `/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/src/index.ts`，
在 `ctx.on('internal/plugin', ...)` 回调里，逐字）：

```
// case 4: fiber is disposed on behalf of plugin deletion (such as plugin hmr)
// self-dispose: ctx.fiber.dispose() -> fiber / runtime dispose -> delete(plugin)
// plugin hmr: delete(plugin) -> runtime dispose -> fiber dispose
```

> 出处更正：本报告早先版本写的是 `dsh-loader`，实际在 `cordis-plugin-loader`。
> 全文用 asar 内所有 `.js/.ts/.mjs/.cjs` 做全文检索，只有这一个文件命中 `plugin hmr: delete(plugin)`。

`plugin hmr: delete(plugin) -> runtime dispose -> fiber dispose` 就是我们在做的事，宿主**把它当成一个已知路径**，并且在这条路径上 Fiber 状态机要处理"删除中"的中间态。我们不等它 settle，等于跳过了状态机。

### 建议的修法

⚠️ **先纠一个坑**：`runtime.fibers` 的类型是 `DisposableList<Fiber>`，**不是数组**。
它是 cordis 自定义的有序集合（`lib/index.js` 里的 `var DisposableList = class {...}`），
有 `length` / `push` / `delete` / `clear` / `[Symbol.iterator]`，**没有 `Array.isArray` 认的那种索引**。
所以直觉写法会静默失效：

```js
// ❌ 永远进不去：Array.isArray(new DisposableList()) === false
if (rt && Array.isArray(rt.fibers)) { ... }
```

正确写法（用迭代器）：

```js
const removals = []
for (const old of new Set([entryPlugin, lastPlugin])) {
  if (!old) continue
  try {
    const rt = registry.delete(old)          // delete() 内部已触发 dispose()，Promise 被丢弃
    if (rt && rt.fibers) {
      for (const f of rt.fibers) {           // DisposableList 可迭代
        // 关键：dispose() 已被调用过一次，再调一次可能抛 INACTIVE_EFFECT
        // 所以优先等 inertia，而不是重复 dispose
        if (f.inertia) removals.push(Promise.resolve(f.inertia))
      }
    }
  } catch { /* 已经没了就算了 */ }
}
if (removals.length) await Promise.allSettled(removals)
```

**但更稳的做法是用 `fiber.await()`**，顺带把加载期的异常也抛出来：

```js
const waits = []
for (const old of new Set([entryPlugin, lastPlugin])) {
  if (!old) continue
  try {
    const rt = registry.delete(old)
    if (rt && rt.fibers) for (const f of rt.fibers) waits.push(f.await())
  } catch { /* 已经没了就算了 */ }
}
await Promise.allSettled(waits)   // 用 allSettled：一个包卸载失败不该拦住别的包
```

> **注意 `await()` 能捕获什么、不能捕获什么**（读了 `fiber.ts` 原文）：
>
> - **能**抛 `apply()` 期失败 —— `_error` 在 `_execute()` 的 catch 里被赋值：
>   `catch (reason) { this.ctx.logger.error(reason); if (...) { this._error = reason } }`
> - **不能**抛卸载期失败 —— 源码注释自己写着：
>   *"`this.inertia` itself should never reject — both `_reload` and `_unload` swallow their own work errors via `ctx.logger.error`."*
>
> 也就是说：**effect undo 里抛的错只进日志，任何 await 都等不到它。** 这是问题 1 的
> 「随机撞名」为什么表现为随机——卸载确实在跑，只是失败了也没人知道。
> 所以 `await` 只能解决「**时序**」（别在别人还没卸完时装新的），不能解决「**卸载本身失败**」。

> 为什么不是「收集 `f.dispose()` 的返回值」：`delete()` **内部已经调过 `fiber.dispose()`** 了。
> `dispose` 是 `parent.fiber.effect(...)` 注册出来的 disposer，重复调用会因 `uid` 已清而命中
> `assertActive()` 的 `INACTIVE_EFFECT`。等 `inertia` 或 `await()` 才是安全的二次观测。

或者更稳的做法：**用 `fiber.inertia`**（宿主 `Fiber` 类里有 `public inertia: Promise<void> | undefined`，`fiber.ts` L200，注释是 *"The in-flight load/unload transition, if one is currently running"*），即「正在进行的装卸转换」。等它 settle 才是真正的「这个 fiber 已经停稳」。

**另一个可用的句柄是 `fiber.await()`**，实测其实现就是「等 inertia 链清空，再把错误抛出来」（`fiber.ts`，逐字）：

```ts
async await() {
  while (this.inertia) {
    await this.inertia
  }
  if (this._error) throw this._error
  return this
}
```

这也印证了本 fork 在 `registry.plugin()` 上 `await` 的必要性：不 await 时 `_error` 永远不会被读出来，`apply()` 抛的错只进 logger，接口照旧 `ok:true`。
注意 `while (this.inertia)` 是**循环**——说明一次 await 可能跨多段转换，这更说明「不等就注册」是不可靠的。

### 验证方法（我这边怎么复现的）

对同一个包连续点名重载 5 次以上，统计失败率。**注意**：如果插件自己做了注册幂等（先摘旧再插新），这个 bug 会被掩盖 —— 所以测试时必须用**没做幂等的插件**（或临时把幂等代码注释掉），否则复现不出来。

---

## 问题 2：平台事务 `reconcileProfile()` 在重复 apply 场景下必然失败

### 现象

不点名（即 `{confirm:true}` 不带 `packages`）时，响应形如：

```json
{
  "ok": true,
  "engine": "local",
  "fellBack": "平台事务失败: dsh: warning: 7 entries did not activate\n<name-a> (<pkg-a>): Error: tool \"<tool>\" is already registered\n<name-b> (<pkg-b>): Error: webserver: duplicate exact route \"/<route>\"\n<name-c> (<pkg-c>): Error: prompt section \"<section>\" is already registered\n..."
}
```

### 关键判断：**这不是"别的插件有问题"，是平台事务本身在重复 apply**

我一开始的结论是「这些插件没做注册幂等，所以连累了平台事务」。**这个归因不完整**，需要作者确认以下推断：

1. `reconcileProfile()` 的意图是「比对磁盘 → 停掉 entry（真 dispose）→ recompose → 用新文件重启 entry」
2. 既然**真 dispose** 了 entry，旧实例的 effect undo 就该把注册全部撤销
3. 那么重组时不该有任何撞名
4. 但实测 7 个包同时撞名 → 说明**旧实例的注册没有被撤销**

三种可能，需要作者确认是哪一种：

| 可能 | 说明 |
|---|---|
| (a) `reconcileProfile()` 对「无变化」的包选择**不 dispose、直接重新 apply** | 那撞名是必然的，需要 be idempotent 才能活 |
| (b) dispose 是异步的，`reconcileProfile()` 也没等 | 与问题 1 同源 |
| (c) 有别的代码路径在 recompose 之前已经把新实例注册了 | 未知 |

**未验证**：我做过「先点名重载某个包 → 再走平台事务」的实验，仍然撞名；但**没做**「重启后不做任何点名重载 → 直接走平台事务」的干净实验，所以还不能排除是点名重载污染了状态。

### 给作者的一个判别方法

在 `reconcileProfile()` 里加一行日志，打印「本次重组实际 dispose 了哪些 entry、每个 entry 的 fiber 是否 await 到 `CLEAN` 状态」。如果某包明明报撞名但**根本不在 dispose 列表里**，那就是情况 (a)。

---

## 问题 3：`reloadViaPlatform()` 把结构化失败压成字符串

`lib/index.js:315-324`：

```js
async function reloadViaPlatform() {
  const hmr = ctx.get('hmr')
  if (!hmr || typeof hmr.runReload !== 'function') return { ok: false, error: 'hmr 服务不可用' }
  try {
    const r = await hmr.runReload(() => hmr.reconcileProfile())
    return { ok: true, engine: 'platform', warnings: (r && r.warnings) || [], pending: (r && r.pending) || [], restartReason: r && r.restartReason }
  } catch (e) {
    return { ok: false, error: '平台事务失败: ' + String((e && e.message) || e) }
  }
}
```

问题：`e.message` 里塞了 **7 个包的完整失败清单 + 换行**，变成一个几百字符的多行字符串。后果：

- 调用方（包括我）无法区分「7 个包都失败」和「1 个包失败」之外的信息
- 每次重载都会吐 7 条警告，**真正的故障会被这 7 条噪音淹没**
- 前端只能做字符串前缀匹配（`client.js:106` 就是这么干的）

### 建议

把每个失败条目解析成结构：

```js
{
  ok: false,
  engine: 'platform',
  failures: [
    { pkg: '<pkg-a>', kind: 'tool', name: '<tool>', message: '...' },
    { pkg: '<pkg-b>', kind: 'route', name: '/<route>', message: '...' }
  ],
  raw: '原始字符串'
}
```

宿主 `warning` 文案是稳定的模板（`tool "X" is already registered` / `prompt section "X" is already registered` / `service "X" has been registered at <Y>` / `webserver: duplicate (exact|prefix) route "X"`），正则提取可靠。

---

## 问题 4：静默 fallback 掩盖了「平台事务失败过」

`lib/index.js:410-428`（`/reload` 处理函数）：

- 不点名 → 先 `reloadViaPlatform()`，失败则 `reloadTargets()` 本地路径
- 最终 `ok: true`，只在响应里多一个 `fellBack` 字段

**问题**：`ok: true` + `engine: 'local'` + `fellBack: "..."` 这个组合，语义是「我说的那件事（平台重组）失败了，但我做了另一件事（本地重载）并成功了」。但：

- 上游版本的客户端**不认识** `fellBack`（`client.js` 是本 fork 加的展示；本 fork 的 `client.js` 是认识的，按 `engine` 分支读两种响应形状）
- 任何只看 `ok` 的调用方都会以为「一切正常」
- 而 `engine: 'local'` 意味着**只有入口模块和它的相对依赖被换掉了**，平台层的配置/governance 重组**根本没做**

### 建议

把语义显式化，别让"成功"承载两种含义：

```js
{ ok: false, reason: 'platform-transaction-failed', fellBackTo: 'local', localResult: {...}, platformError: '...' }
```

或者至少把 `ok` 的含义写进 README：**`ok` 只表示"代码更换成功"，不表示"profile 重组成功"**。

---

## 问题 5：`?dshReload=` 会污染插件的 `import.meta.url`

代码里 `lib/index.js:215-220` 已有注释说明，这里补一份实测记录：

| 场景 | 结果 |
|---|---|
| 被重载模块里 `fileURLToPath(import.meta.url)` | ✅ 正常（query 被剥掉） |
| 相对依赖是否被复制成两份 | ✅ 否（Node 归一化相对说明符，同一实例） |
| 用 `import.meta.url` 做**字符串比较**的插件 | ❌ 会看到 `...?dshReload=1730...` |

**实测影响面**：在十余个插件组成的环境里，没有发现因这条而坏。但这是**潜在的破坏面**，建议在 README 里明确写出来，让插件作者知道。

### 附带（更值得注意）

`registerHooks` 把 query 只传给 `./` 和 `file:` 开头的说明符，**裸模块不动**（避免单例裂成两份）。这是对的。**但副作用是：如果某个被重载模块依赖了另一个插件包（裸模块名），那个依赖不会被重载。** 实测遇到过这个情况 —— 主包换了，裸模块依赖还是旧的。

---

## 问题 6：文档没写清「重启按钮依赖另一个插件」

### 现象

「重启」按钮不是本插件实现的，它 POST 到 `/dsh-hot-restart/restart` —— 由 `dsh-hot-restart` 提供引擎。
本插件只注册了两个路由（`/dsh-quick-restart/info` 和 `/dsh-quick-restart/reload`），**没有** restart 路由。

实测（本机，宿主端口 `<PORT>`）：

```
GET  /dsh-quick-restart/info       -> 200
GET  /dsh-quick-restart/reload     -> 403   （GET 不带 fence 头，符合预期）
POST /dsh-quick-restart/reload     -> 403   （缺 x-dsh-quick-restart 头）
POST /dsh-quick-restart/reload     -> 403   （带头但 Origin: null）
GET  /dsh-quick-restart/restart    -> 404
POST /dsh-hot-restart/restart      -> 401   ← 另一个插件，需要它自己的鉴权
```

### 需要改的地方

| 项 | 问题 | 建议 |
|---|---|---|
| `/reload` 的自定义头 | README 未写 `x-dsh-quick-restart: 1`。这是**安全设计**（防 CSRF，实测有效：缺头、`Origin: null` 都被 403），但没文档，外部调用方会以为接口坏了 | 在 README 边界节补一句「`/reload` 只接受同源请求且需自定义头；没有对外 API」 |
| 「重启」按钮的依赖 | README L25/L87/L88 **已经写对了**（「需要 `dsh-hot-restart` 提供引擎」「没装也能用重载，只是重启那颗点了没反应」） | 无需改。**本报告早先版本写「安装说明指向 dsh-hot-restart」是错的**，核查后已删除该条 |
| 平台 HMR 的记载 | `docs/dev-notes.md` 原写「改文件 2 秒内生效，全程没点按钮」，实测不成立 | 已在 `4620739` 标注**作废**，更正为「没测出效果」，并说明二测用可证伪办法 |

---

## 问题 7：平台 HMR 在 Windows 下会**静默失效**（框架侧，零日志）

> 这条严格说属于 `@deepseek-ai/dsh-hmr`，不属于本插件。放进来是因为它和问题 2/3/4 同属
> 「平台侧反馈缺失」，而且它直接决定本插件的自动重载能力到底能不能用。

### 现象

给 `dsh-hmr` 配 `root: ["D:/.../某插件"]`（**绝对路径**）、但没配 `config.base` 时：

**保存任何文件后什么都不会发生** —— 不改代码、不报错、不打日志，等 40 秒也一样。
不是「慢」，是**根本没被触发**。

### 根因（逐行读宿主源码定位）

`dsh-hmr` 的 `configure()`：

```js
const match = picomatch(ignored);
const watchBaseDir = realpathSync(this.baseDir);
this.watcher = watch(root, {
  ...this.config,
  cwd: watchBaseDir,
  ignored: (path) => match(relative(watchBaseDir, path)),
  ignoreInitial: true
});
```

其中 `baseDir = fileURLToPath(new URL(config.base || ".", ctx.baseUrl))`。

`root` 是绝对路径而 `base` 没配 → `watchBaseDir` 落到 `dsh-hmr` **自己的目录**（在 `app.asar` 里），
两者不在同一棵树下，`relative()` 于是算出带 `..` 段的串：

```
..\..\..\..\..\..\..\0data\0dsh\某插件\version.js
```

picomatch 把以 `.` 开头的段当隐藏文件，默认 `ignored` 里的 **`**/.*`** 一条就命中它
（实测 `picomatch(['**/.*'])('..\\..\\x.js') === true`）。

**结果：文件在 chokidar 层就被 ignored，`changed` 集合永远为空，`dispatch` 提前 return —— 连一行 warn 都没有。**
这解释了为什么它看起来像「什么都正常，就是不生效」。

### 第二个坑（修好第一个才会撞上）

补上 `base` 之后，`relative()` 返回 Windows 原生**反斜杠**路径，而 **picomatch 不把 `\` 当路径分隔符**：

```js
picomatch(['**/node_modules'])('a\\node_modules')  // false
```

于是默认的 `**/node_modules`、`**/.*` 在 Windows 上**一条都匹配不上** —— watcher 会老老实实去监听
整个 `node_modules` 和 `.git`。

### 修法（配置层，不用改框架代码）

```yaml
- id: hmr
  name: "@deepseek-ai/dsh-hmr"
  config:
    base: "file:///D:/0data/0dsh"     # 插件共同父目录，必须是 file:// URL
    root:
      - "D:/0data/0dsh/某插件"
    ignored:                          # 必须写成反斜杠形式
      - '**\\node_modules'
      - '**\\node_modules\\**'
      - '**\\.*'
      - '**\\.*\\**'
```

两个必须注意的点：

- `base` **不能写纯路径**：`new URL('D:/0data/0dsh', baseUrl)` 会解析成 `d:/0data/0dsh`（无 scheme），
  `fileURLToPath()` 随后抛 `ERR_INVALID_URL_SCHEME`，插件**启动直接失败**。可用写法只有
  `file:///D:/...` 或相对 `ctx.baseUrl` 的 `../..` 链。
- watcher 在 `configure()` 时创建，**改配置要重启一次 DSH** 才会重建；之后所有源码保存都不再需要重启。

### 证据（A/B 对照 + 线上验收）

用与宿主**同版本**的 chokidar 5.0.0 + picomatch（从 `app.asar` 抽出）在独立进程里 1:1 复刻 `configure()`，
喂同一套探针文件：

| 配置 | 4 个插件目录各自收到 change | node_modules 探针 |
|---|---|---|
| 旧（无 `base`，用默认 ignored） | **0 条**（全部） | — |
| 新（`base` + 反斜杠 ignored） | **4/4 全部收到** | ✓ 被正确忽略 |

旧配置连一条 change 都没收到，与线上「保存无任何反应」完全吻合。

修好后线上验收：改一个字符串，**+1.1 秒**接口返回值就变了，进程 pid **不变**（桌面窗口不动）。

### 建议

1. 别把 `relative()` 的结果直接当 glob 输入 —— 先 `normalize`，或干脆用前缀判定代替 glob
2. Windows 下把分隔符统一成 `/` 再喂 picomatch（或用 `picomatch(..., { windows: true })`）
3. **失败路径至少要打一行 `warn`** —— 本次根因能潜伏这么久，唯一原因就是它完全静默

---

## 需要作者确认的问题（我无法自行验证）

1. **`reconcileProfile()` 对「无变化」的包，是 dispose 后重装，还是直接再 apply 一次？** → 决定问题 2 是"平台的 bug"还是"插件的幂等义务"。
2. **`fiber.inertia` 是否就是官方推荐的"等 fiber 停稳"的句柄？** 我打算用它来修问题 1，但想要作者确认这不是内部字段。
   （我读到的是 `public inertia`，公开可见、有 JSDoc，但没在任何 `.d.ts` 导出文档里见过。）
3. **`registry.delete()` 丢弃 `fiber.dispose()` 的 Promise 是故意的吗？** 如果是（比如上层有别的同步点保证顺序），那问题 1 的修法就要换。
4. **卸载期异常被 `_unload()` 吞进 logger，是设计如此吗？**
   源码注释明确说 `inertia` 永不 reject、`_reload`/`_unload` 自己用 `ctx.logger.error` 吞掉。
   后果是：**effect undo 失败时，外部没有任何办法知道**。如果这是有意的（认为 undo 不该失败），
   那问题 1 的"随机撞名"就永远只能靠超时/重试兜，而不能靠等信号解决。这一点对修法影响最大。

---

## 附：我这边为定位这些问题做的实验（可复现）

| 实验 | 结论 |
|---|---|
| 同一个 `file:` URL 二次 `import`，改文件后重载 | 仍返回旧模块 → **ESM 引擎级缓存**，必须加 `?dshReload=` |
| 清 `loader.internal.loadCache` 前后对比 | `cleared: 0` → `31`。**junction 部署下必须 `realpathSync.native`** 才匹配得上 key |
| `cleared: 31` 之后代码是否真的换了 | **没有** → 证明 `cleared` 不能作为"重载成功"的判据 |
| 只加 `?dshReload=` 不改依赖图 | 入口换了、依赖没换 → 需要 `registerHooks` 传播 query |
| 不点名重载 ×3 | 全部 fallback 到 local，12 包成功，7 包报撞名 |
| 点名重载 + 立即不点名重载 | 仍报我们自己的包撞名 → 问题 1 的直接证据 |

---

## 我这边已经做的修复（供作者参考，不一定适合上游）

| 改动 | 提交 | 说明 |
|---|---|---|
| `realpathSync.native` 解析 junction 前缀 | `e7a2db7` 前 | 否则 `cleared` 恒为 0 |
| `?dshReload=<ts>` 击穿 ESM 缓存 | `e7a2db7` 前 | 否则清完缓存还是旧代码 |
| `registerHooks` 传播 query 到相对依赖 | `e7a2db7` | 否则只换入口 |
| 响应加 `propagation` 字段 | `e7a2db7` | `cleared>0` 不证明依赖也换了 |
| `await registry.plugin()` + 5s 超时 | `e7a2db7` 前 | 否则 `apply()` 抛错被吞成 `ok:true` |
| 优先走平台事务 + fallback | `e7a2db7` 后 | 见问题 2 |
| POST 自定义头 + 同源双闸 | `ebfcb96` | 防 CSRF |

**问题 1 我没修**，因为需要作者先确认第 3 个问题（`delete()` 丢弃 Promise 是否有意）。
