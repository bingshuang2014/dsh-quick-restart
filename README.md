# dsh-quick-restart

![标题栏上的「重载插件」与「重启」按钮](images/titlebar.png)

给 **DeepSeek Harness（DSH）** 标题栏加两个按钮：**重载插件代码**（不用关程序）和 **重启 DSH**。

> 中文为主，末尾有简短的 English 说明。

## 它解决什么问题

DSH 的第三方插件改了代码之后，默认要**完全退出再打开**才生效（刷新页面没用，热重载也不会自动发生）。
这个插件在标题栏菜单栏加两个按钮，把这件事变成点一下：

- **重载** —— 只重新加载第三方插件，主进程和会话都不动，实测 8/8 成功；
- **重启** —— 关掉并重开 DSH（需要另外安装 [`dsh-hot-restart`](https://github.com/InariNGT-Ofiicial/dsh-hot-restart) 提供重启引擎，没装就只有"重载"可用）。

## 安装

### 方式一：从 GitHub Release 装（已发布）

```
https://github.com/a994903574/dsh-quick-restart/releases/download/v0.1.1/dsh-quick-restart-0.1.1.tgz
```

把这个地址填进 DSH 的插件安装入口即可（和装其它第三方插件一样）。

### 方式二：从 npm 市场装（尚未发布，等账号开通）

DSH 设置页 →「插件」→ 搜索 `dsh-quick-restart` → 安装 → **完全退出 DSH 再打开**（首次必须，按钮要用宿主启动时的注入表）。

或者手动：

```bash
cd <你的 DSH profile 目录>
pnpm add dsh-quick-restart
```

并在 profile 的 `package.json` 里把它加进 `dsh.profile.bundles`。

## 用起来什么效果

标题栏菜单栏（文件/编辑那一条的右侧）多出两个小按钮：**重载**、**重启**。
点"重载"后，按钮会短暂显示结果；如果有插件重载失败，鼠标悬停能看到是哪个包、什么错误。

## 边界（老实说）

- **只重载第三方插件**。`@deepseek-ai/*`（宿主内置，在 app.asar 里）和 `cordis:*`（虚拟分组）会被跳过——碰它们必然失败。
- **前端 bundle 不会跟着换**。插件如果带前端界面，重载后界面那段还是旧的，得重启程序。这是宿主机制，不是本插件的问题。
- **重启按钮依赖 `dsh-hot-restart`**。没装也能用"重载"，只是重启那颗点了没反应。
- 仅测试于 **Windows 桌面版**。其他平台未验证。

## 本地修复（fork 相对上游）

本仓库是 [`bingshuang2014/dsh-quick-restart`](https://github.com/bingshuang2014/dsh-quick-restart) 的**本地 fork**（上游原作者 [`a994903574/dsh-quick-restart`](https://github.com/a994903574/dsh-quick-restart)，main 停在 0.1.1，基本无维护），基线是 0.1.1，版本号自 0.1.2 起。

修的是**热重载静默失效**：接口返回 `{"ok":true}`，代码却根本没换。两个独立缺陷叠在一起：

| 缺陷 | 位置 | 现象 | 修法 |
|---|---|---|---|
| ① 前缀对不上 | `lib/index.js` `invalidateDir` | 用 `fileURLToPath(url)` 拿到的是 **profile 里的 junction 路径**，而 `loader.internal.loadCache` 的 key 是 Node 解析后的**真实路径**，前缀不匹配 → 一条都清不掉（实测 `cleared = 0`）→ `loader.import` 命中缓存返回旧模块 | 先用 `realpathSync` 解析 junction 再算前缀 |
| ② 引擎级缓存 | `lib/index.js` `reloadOne` | 即使 `loadCache` 清干净（实测 `cleared = 31`），Node 的 **ESM 模块表**（引擎级 ModuleMap）对同一个 `file:` URL 第二次 `import` 直接返回缓存模块 | `loader.import` 的 URL 追加 `?dshReload=<ts>`，每次 URL 都不同 |

另外三条是**独立验证（离线最小实验）推翻了原方案后改的**，都能复算：

| 现象 | 原因 | 处理 |
|---|---|---|
| 重载 `A` 会连 `A-old` / `A.bak` / `A-deep` 的缓存一起清（实测清 6 条，本包只有 3 条） | 上游第一道清理 `k.indexOf(prefix) >= 0` 是纯子串匹配，**没有路径边界**（上游原有，不是本 fork 引入） | 前缀匹配加边界：`k === prefix \|\| k.indexOf(prefix + '/') >= 0` |
| URL 指向不存在的文件时，清理范围会放大到**整个祖先工程目录**（实测 17 条 key 全灭） | `package.json` 向上查找一路走到祖先工程的 `package.json`；而 `loader.import` 随后必然失败，清缓存毫无意义 | 文件不存在就直接 `return 0`，不再向上走 |
| 「前缀没命中时按父目录名松匹配」的兜底会**误删跨盘同名包**的缓存（反例已确证：`<另一个盘符>:/otherplace/<同名包>/...`） | 松匹配串（`/base/`、`/base.`）没有任何路径范围约束；而这个兜底在本机的 junction 部署里从不需要触发 | **不采用**（原本是可选方案，验证后删掉） |

顺带把失败暴露出来：`reloadOne` 现在返回 `{ cleared }`，`reloadTargets` 把它透出到响应里。
**上游只报 `ok`/`error`，于是「清 0 条 = 其实没重载」被显示成成功** —— 这个 bug 能活这么久，就是因为失败被报成了成功。

`POST /dsh-quick-restart/reload` 的响应长这样：

```json
{ "ok": true, "result": [ { "pkg": "<plugin-a>", "ok": true, "cleared": 31 } ] }
```

### 已知行为变化（用它之前要知道）

击穿引擎级缓存必须换 URL，代价是：**被重载模块里的 `import.meta.url` 会带上 `?dshReload=<ts>`**。

- `fileURLToPath(import.meta.url)` 仍然正常（会剥掉 query）；
- 相对依赖**不会**被复制成两份（实测：同一实例，Node 会归一化相对说明符）；
- 但**任何把 `import.meta.url` 拿去做字符串拼接／比较的插件会看到多出来的 query**。本插件自己的 `HERE` 走 `fileURLToPath`，不受影响。

### 怎么判断真的修好了（别只看 `ok`）

`ok: true` 只代表没抛异常。唯一可信的是**可观测标记对照实验**：

1. 在目标插件里加一处可观测的标记（例如它的 health 路由返回值里加一行 `reloadMark: 'MARK_V1'`）；
2. 重载**之前**先读一次接口 → 应看不到该标记；
3. `POST /dsh-quick-restart/reload` `{"confirm":true,"packages":["<包名>"]}`；
4. 再读一次 → 标记**出现**了才算真的重载成功（没出现就还有第三层缓存）；同时看响应里的 `cleared`：`cleared: 0` 说明缺陷① 没修好；`cleared > 0` 但标记没变说明缺陷② 没修好；
5. 验证完立刻删掉那个标记，并再重载一次恢复原状。

## 卸载

```bash
pnpm remove dsh-quick-restart
```
再从 `dsh.profile.bundles` 里删掉对应条目，重启 DSH。

## 它是怎么做的（给好奇的人）

桌面壳的 `index.html` 直接读安装包里的静态 dist，不走 `renderIndex`，所以 `webServer.tapIndex` 无效。
唯一可用的通道是宿主启动时**一次性收集**的 `webserver/index-inject` 注入表——所以插件里不能写对象级 `inject = ['webServer']`，
否则 `apply()` 会推迟到 webServer 就绪之后，错过那次收集，界面上永远看不到按钮。这一点已在代码注释里写明。

重载本身是：取 loader 的 entries → 清掉该包在 `loader.internal.loadCache` 里的模块 → 重新 import → 用新插件替换旧的 fiber。

## English (short)

**dsh-quick-restart** adds two titlebar buttons to DeepSeek Harness: **reload** third-party plugins without restarting the app, and **restart** DSH
(the latter requires `dsh-hot-restart`). Built-in `@deepseek-ai/*` plugins and front-end bundles are intentionally not hot-reloaded — that's a host limitation.
Tested on Windows desktop only. MIT licensed.

## License

MIT
