# Sakura Cline Sync

把 Cline 的本地对话历史定时同步到 Sakura-MCP-Server，自动抽取长期记忆。托盘常驻 + 本地配置面板，不需要手动触发。

## 它解决什么问题

MCP 是「工具」而非「监听器」：服务端看不到你和模型的对话，只有客户端主动调用工具时才写入。靠 `.clinerules` 让模型自己在结尾调 `memory_extract_and_remember` 并不可靠——模型会忘。

本工具改为读取 Cline 落盘的对话历史，定时增量推送，是文件级的硬采集，不依赖模型自觉。

## 工作方式

```text
定时扫描 Cline 任务目录
  → 按 taskId 对比游标，只取新增消息
  → 脱敏（默认开启）
  → 调用 memory_extract_and_remember，由服务端抽取并入库
  → 成功后推进游标；失败保持原位，下次重试
```

Cline 的历史目录（Windows）：

```text
%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\tasks\<taskId>\api_conversation_history.json
```

macOS 与 Linux 会自动换成对应的 `globalStorage` 路径，也可以在面板里手动指定。

## 安装与运行

### 方式一：单文件 exe（推荐）

```bash
cd tools/cline-sync
npm install
npm run package
```

产物在 `release/cline-sync.exe`（约 95 MB，内置 Node 22 运行时与托盘辅助程序），双击即可运行，目标机器无需安装 Node.js。默认只构建 `node22-win-x64`；要交叉编译其他平台，改 `package.json` 里 `pkg.targets`，例如：

```json
{ "pkg": { "targets": ["node22-win-x64", "node22-macos-arm64", "node22-linux-x64"] } }
```

首次启动时，内置的托盘辅助程序会从只读快照解包到 `%APPDATA%\sakura-cline-sync\traybin\`，之后复用。

### 方式二：从源码运行

```bash
cd tools/cline-sync
npm install
npm run build
node dist/main.js
```

开发期直接用 `npm run dev`（tsx，无需先编译）。

首次启动会打印配置面板地址，例如 `http://127.0.0.1:53124/?token=...`。若尚未配置 MCP 地址与密钥，程序会自动弹出配置窗口；之后可从托盘菜单点「打开配置窗口」再次打开。

## 配置窗口

配置界面以独立桌面窗口打开，无地址栏、无标签页，看起来就是一个普通应用窗口。实现方式是复用机器上已安装的浏览器引擎（Windows 优先 Edge/WebView2，其次 Chrome；macOS 与 Linux 同理），以 `--app` 模式启动，因此不需要打包 Electron，exe 体积不受影响。

窗口使用位于 `%APPDATA%\sakura-cline-sync\panel-profile\` 的独立配置目录，与你日常浏览器会话隔离——面板地址里的 token 不会进入浏览历史，也不会被已打开的浏览器窗口接管。

若机器上找不到可用引擎，会退回用默认浏览器打开同一地址，功能完全一致。

## 配置项

| 项 | 说明 |
| --- | --- |
| MCP 地址 | `https://<你的域名>/mcp` |
| Agent 密钥 | 后台「Agent 密钥」创建，需 `memory:write` 权限，且必须为目标空间「授权空间」 |
| Cline 任务目录 | 留空自动检测 |
| 扫描间隔 | 默认 10 分钟，1–1440 |
| 忽略早于 | 默认 30 天，0 表示不限 |
| 上传前脱敏 | 默认开启 |
| 启用自动同步 | 关闭时只能手动触发 |
| 选择方式 | `全部` / `仅同步勾选的任务` / `排除勾选的任务` |

配置与游标存放位置（Windows）：`%APPDATA%\sakura-cline-sync\`，其中 `config.json` 含密钥，以 `0600` 权限写入。

## 任务选择

配置面板的「任务选择」区列出磁盘上的每个 Cline 任务，显示最后活动时间、总消息数、待推送消息数、上次同步时间，以及本次是否会同步。底部汇总本次会同步几个任务、合计多少条消息、约产生几次抽取调用，便于在触发前估算成本。

三种模式：

- **全部**：同步时间窗口内的所有任务（默认）。
- **仅同步勾选的任务**：白名单。空列表表示不同步任何任务，而不是回退成同步全部——这是刻意的，避免误配置导致意外全量上传。
- **排除勾选的任务**：黑名单。

时间窗口优先于选择：被「忽略早于」排除的任务即使勾选也不会同步，列表中显示为「超出时间范围」。

## Agent 权限

Agent 有两层权限，必须同时满足才能写入：

1. 全局 scopes：创建 Key 时勾选 `memory:write`。
2. 空间级授权：在后台「Agent 密钥」中点该 Key 的「授权空间」，选择目标空间并勾选 `memory:write`。

只有第 1 层会导致同步报 `Agent is not granted memory:write in this space.`。失败的任务不会推进游标，补齐授权后重试即可，不会漏数据。

## 托盘菜单

打开配置窗口、立即同步、状态显示（每 5 秒刷新）、暂停/恢复自动同步、退出。若系统不支持托盘，程序会退回控制台模式继续运行而不是退出。

## 命令行

```bash
npm run dry-run     # 干跑：只报告会上传什么，不联网
npm run sync-once   # 执行一次同步后退出，适合 cron / 计划任务
npm run package     # 构建单文件 exe 到 release/
```

## 安全说明

- 配置面板只监听 `127.0.0.1`，且每次启动生成随机 token，网络上无法访问。
- 面板返回配置时密钥是掩码的；提交时留空即保留原值。
- 脱敏覆盖 `sk_sakura_`、`sk-`、`ghp_`、`xox*`、`AKIA`、JWT、`Authorization: Bearer`、PEM 私钥块，以及 `password=`/`token:` 这类键值对。这是尽力而为的防护，不是保证——本工具会把整段对话送去抽取，敏感项目请谨慎启用。
- 认证走 Agent 密钥（Bearer），不涉及 OAuth 与动态客户端注册。

## 成本提示

`memory_extract_and_remember` 每次调用都会消耗服务端配置的 Chat Provider 额度。增量游标已经避免了重复抽取，但活跃对话仍会每个周期产生一次调用。想更省可以把扫描间隔拉长，或把「忽略早于」调小。
