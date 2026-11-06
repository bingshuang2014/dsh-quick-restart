# dsh-quick-restart

![标题栏上的「重载插件」与「重启」按钮](images/titlebar.png)

给 **DeepSeek Harness（DSH）** 标题栏加两个按钮：**重载插件代码**（不用关程序）和 **重启 DSH**。

> 中文为主，末尾有简短的 English 说明。
> 想看内部实现、缺陷根因、上游版本差异 → [docs/dev-notes.md](docs/dev-notes.md)

## 它解决什么问题

DSH 的第三方插件改了代码之后，默认要**完全退出再打开**才生效（刷新页面没用，热重载也不会自动发生）。
这个插件把它变成点一下：

- **重载** —— 只重新加载第三方插件，主进程和会话都不动；
- **重启** —— 关掉并重开 DSH。

## 功能

**按钮**

| 功能 | 说明 |
|---|---|
| 标题栏「重载插件」 | 只换插件代码，**窗口和进程不动** |
| 标题栏「重启」 | 关闭并重开 DSH，需要 [`dsh-hot-restart`](https://github.com/InariNGT-Ofiicial/dsh-hot-restart) 提供引擎 |
| 与原生按钮同款样式 | 运行时从旁边「文件」「编辑」复制计算样式，主题/字号/DPI 变了也不漂 |

**重载能力**

| 功能 | 说明 |
|---|---|
| 两级引擎 | 默认走平台第一方事务（账目一致、无残留）；平台不可用则自动退回本地路径，并**告知已退回**，绝不假装成功 |
| 点名重载 | 只救某一个包，不动其它 |
| 保存文件即生效（可选） | 配好 HMR 的 `root` 后，改代码**不用点按钮**，约 2 秒自动生效 |
| 真实反馈 | 按钮显示 `已重载` / `有 N 条警告` / `进行中 N` / `需重启`，悬停看详情 |
| 不误伤邻居 | 路径边界匹配，不会清掉同名前缀、同名兄弟包的缓存 |

**安全**

| 项 | 状态 |
|---|---|
| 出网请求 | **0 个**（只有两个本机相对路径的 `fetch`） |
| 磁盘写入 | **不写盘** |
| 读会话/配置/凭据 | 无 |
| 跨站请求伪造（CSRF） | 已堵：`/reload` 要求自定义头 + 同源校验 |

## 安装

**方式一：从 Release 装（推荐）**

从 [Releases](https://github.com/bingshuang2014/dsh-quick-restart/releases) 下载最新 `.tgz`，把地址或文件填进 DSH 的插件安装入口。

**方式二：从源码 link（开发用）**

```
git clone https://github.com/bingshuang2014/dsh-quick-restart.git
```

然后在该目录执行 `pnpm link`，或把目录 junction 进 profile 的 `node_modules`。

> **npm 上那个 `dsh-quick-restart` 不是这个 fork** —— 它属于另一位作者（`a994903574`），停在 0.1.4，没有上面这些修复。这个 fork 没有发布到 npm，请从 GitHub 装。

> 首次装完必须**完全退出 DSH 再打开**一次：按钮要用宿主启动时收集的注入表，装完即时不会出现。

## 用起来什么效果

菜单栏（文件/编辑那一条的右侧）多出两个按钮：**重载**、**重启**。
点「重载」后按钮会短暂显示结果：

| 显示 | 含义 | 悬停可看 |
|---|---|---|
| `已重载` | 平台事务完成，无警告 | — |
| `有 N 条警告` | 有插件没激活或注册冲突 | 逐条列出 |
| `进行中 N` | N 个模块要等刷新页面才换成新的 | 说明 |
| `需重启` | 平台判定这些改动热重载覆盖不了 | 原因原文 |
| `已重载 N 个` | 走了本地路径（点名了包，或平台不可用） | 失败包与错误 |
| `平台失败·已退回，…` | 平台事务抛错，已降级到本地路径 | 同上 |

## 边界（老实说）

- **只重载第三方插件**。`@deepseek-ai/*`（宿主内置，在 app.asar 里）会被跳过。
- **前端 bundle 不会跟着换**。插件带界面的，重载后界面那段还是旧的，得重启程序。这是宿主机制。
- **重启按钮依赖 `dsh-hot-restart`**。没装也能用「重载」，只是重启那颗点了没反应。
- **不隐藏 `dsh-hot-restart` 自带的浮动按钮**。标题栏两颗 + 原版那颗「热重启 dsh」并存，点下去是同一个引擎。理由很实际：标题栏按钮依赖"宿主启动时一次性收集的注入表"，这次没赶上就不会出现——那时若把原版藏着，用户一个重启入口都没有。
- 仅测试于 **Windows 桌面版**。

## 卸载

```bash
pnpm remove dsh-quick-restart
```

再从 profile 的 `dsh.profile.bundles` 里删掉对应条目，重启 DSH。

## English (short)

**dsh-quick-restart** adds two titlebar buttons to DeepSeek Harness: **reload** third-party plugins without restarting the app, and **restart** DSH
(the latter requires `dsh-hot-restart`). Built-in `@deepseek-ai/*` plugins and front-end bundles are intentionally not hot-reloaded — that's a host limitation.
Tested on Windows desktop only. MIT licensed.

## License

MIT
