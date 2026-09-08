# 更新日志

本文件记录 Sakura-MCP-Server 的所有重要变更。

## [0.3.2] - 2026-08-31

### 新增

- 管理后台新增「客户端」页，展示已接入的 MCP 客户端及其状态。MCP 使用无状态 HTTP 传输、不保持长连接，因此状态由最近活动时间推导：**上传记忆中**（有工具调用正在进行）、**已连接**（90 秒内有活动）、**空闲**（15 分钟内有活动）、**已断开**（显式关闭或超过 15 分钟无活动）。每行还显示客户端名称与版本、MCP 协议版本、所属 Agent、来源地址、最近一次调用的工具，以及累计请求数、写入调用数和错误数。页面可每 10 秒自动刷新，便于观察上传过程。
- 客户端会话按用户隔离：普通用户只能看到自己的客户端，系统管理员可查看全部。会话主键由「用户 + Agent + 客户端名」哈希得出，客户端自报的名称无法与其他用户的记录碰撞或冒充。
- 客户端自报的名称、版本、协议版本在入库前统一去除控制字符并限长，前端一律通过 `textContent` 渲染。

### 升级提示

- 需要执行数据库迁移 `010_client_sessions.sql`（`AUTO_MIGRATE=true` 时自动执行）。
- 会话跟踪属于观测数据，写入失败只记录警告，不会影响 MCP 请求本身。

## [0.3.1] - 2026-08-31

### 新增

- 登录页在检测到 Authentik 单点登录会话时显示「以 *** 的身份登录」。`/auth/login` 首次访问会发起一次 `prompt=none` 静默探测：命中则读取显示名并渲染确认按钮，同时提供「使用其他账号登录」；未命中则完全沿用原有登录流程。探测只读取显示名，不创建会话、不写入用户表，因此退出登录后仍不会被静默续登。探测事务在数据库层通过 `purpose` 列与登录事务隔离（`oidc_login_attempts.purpose`，取值 `login`/`probe`），claim 时把 purpose 写进 `WHERE` 条件，使探测取得的授权码无法被兑换为 Web 会话。
- 登录页改用与生活看板一致的双栏布局与自托管字体（Noto Sans SC / DM Mono，均为 SIL OFL 1.1），并支持日间、夜间、跟随系统三种外观；主色沿用 Sakura 樱粉。字体由 `api.mcylyr.cn` 统一提供，CSP 仅为该域名放行 `style-src` 与 `font-src`，脚本与数据连接仍限制在本站。
- 新增配套工具 `tools/cline-sync`：托盘常驻的同步守护程序，定时扫描 Cline 本地对话历史（`globalStorage/saoudrizwan.claude-dev/tasks`），按任务游标只推送增量消息，调用 `memory_extract_and_remember` 由服务端抽取长期记忆，无需依赖模型主动调用工具。附带本地配置面板（仅监听 127.0.0.1、每次启动随机 token）、上传前密钥脱敏、干跑与单次同步命令。
- `tools/cline-sync` 支持打包为单文件可执行程序：`npm run package` 使用 `@yao-pkg/pkg` 的 SEA 模式产出 `release/cline-sync.exe`，内置 Node 22 运行时与托盘辅助程序，目标机器无需安装 Node.js。首次启动会把托盘辅助程序从只读快照解包到用户数据目录再运行。
- `tools/cline-sync` 配置界面改为独立桌面窗口：复用机器上已安装的浏览器引擎（Windows 优先 Edge/WebView2，其次 Chrome）以 `--app` 模式启动，无地址栏与标签页，不需要打包 Electron，exe 体积不变。窗口使用独立的 `panel-profile` 配置目录，面板 token 不会进入日常浏览历史，也不会被已打开的浏览器窗口接管；找不到可用引擎时退回默认浏览器。首次启动若尚未配置 MCP 地址与密钥会自动弹出该窗口。
- `tools/cline-sync` 新增按任务选择性同步：配置面板列出每个 Cline 任务的最后活动时间、总消息数、待推送消息数与上次同步时间，可选择「全部」「仅同步勾选的任务」「排除勾选的任务」三种模式，并在触发前汇总本次会产生多少次抽取调用。时间窗口优先于选择，被「忽略早于」排除的任务即使勾选也不会同步。

### 升级提示

- 需要执行数据库迁移 `009_login_probe.sql`（`AUTO_MIGRATE=true` 时自动执行）。
- 「以 *** 的身份登录」要求 Authentik 侧该 Provider 的同意模式为隐式（implicit consent）。若配置为每次登录都需确认，探测会返回 `consent_required`，此时页面静默回退到普通登录流程，不会报错。

## [0.3.0] - 2026-08-29

### 修复

- 修复 MCP 客户端（Cline、Claude Desktop 等）无法连接的严重缺陷。`/mcp` 与根域名的 MCP 请求在认证通过后返回的是 `200` + `Content-Type: text/event-stream` 但 body 为空的响应，客户端表现为 `MCP error -32000: Connection closed` 或 60 秒后 `MCP error -32001: timed out`。原因是 `handleRequest()` 在拿到 `Response` 对象时就已 resolve，而 SSE body 仍在持续写出，此时 `finally` 分支立刻 `transport.close()` 把流拆掉，导致一个字节都没发出。现在改为在响应流真正结束、出错或被客户端取消后才关闭 transport 与 server，既保证 SSE 完整送达，也不会泄漏连接。

### 提示

- 若使用 Nginx 等反向代理，`/mcp` 所在的 `location` 需要 `proxy_buffering off;`，否则 SSE 流会被缓冲。
- Authentik 不支持动态客户端注册（RFC 7591 DCR）时，MCP 客户端请改用 Agent 密钥直连，在客户端配置中设置 `"type": "streamableHttp"` 与 `headers.Authorization` 为 `Bearer sk_sakura_...`，即可跳过 OAuth 流程。

## [0.2.29] - 2026-08-29

### 变更

- Agent 密钥的「撤销」改为「删除」：直接从数据库移除凭据，而不是保留 `revoked_at` 标记的历史行。密钥立即永久失效且无法恢复，关联的空间授权级联删除，历史记忆与审计记录保留但 Agent 引用置空。管理后台和 MCP 工具 `agent_revoke` 相应改名为 `agent_delete`。

## [0.2.28] - 2026-08-28

### 变更

- Agent 密钥改为可随时查看，不再只在创建时显示一次。创建时会用 `CONFIG_ENCRYPTION_KEY` 以 AES-256-GCM 加密保存 token 副本，管理后台「Agent 密钥」列表新增「查看密钥」按钮，可随时展开或隐藏明文，每次查看都会写入审计日志。认证仍然只比对 SHA-256 哈希，加密副本仅用于展示，且只有 Key 的所有者能查看。0.2.28 之前创建的 Key 没有加密副本，无法再次查看，需撤销后重新创建。

## [0.2.27] - 2026-08-28

### 变更

- Authentik 超级用户现在默认就是 Sakura 的系统管理员，无需任何额外配置。Authentik 默认的 `profile` 权限映射本身就会在 ID Token 中返回用户所属用户组名称，因此登录时只要 `groups` 声明包含内置的 `authentik Admins`，即自动获得系统管理员权限，不再需要先靠安装邮箱或手工改数据库来解锁「模型 Provider」「身份认证」页面。
- 「管理员用户组」保持可选：填写后完全替代内置的 `authentik Admins` 并成为权威判据（未命中即回收管理员身份）；留空时只提权、不降权，手工授予的管理员不会被回收。
- 修正 0.2.26 引入的登录 scope：不再请求不存在的 `groups` scope，用户组由 Authentik 默认的 `profile` 映射提供。

## [0.2.26] - 2026-08-28

### 新增

- 支持通过 Authentik 用户组授予系统管理员权限。在安装向导和管理后台的「身份认证」中填写「管理员用户组」（多个用英文逗号分隔），登录时 ID Token 的 `groups` 声明命中任一组即成为系统管理员；未命中则回收管理员身份，因此在 Authentik 侧调整用户组后下次登录即生效。安装时填写的系统管理员邮箱始终保留管理员权限，不受用户组影响。浏览器登录请求的 scope 增加 `groups`。
- 用户组声明字段可通过 `groupsClaim` 自定义，默认 `groups`。未配置管理员用户组、或提供方未下发该声明时，完全沿用原有的邮箱白名单逻辑，不会误降权。

### 升级提示

- 需在 Authentik 的 OAuth2/OIDC Provider 的 Scopes 中加入 `groups` 属性映射（`authentik default OAuth Mapping: OpenID 'groups'`），否则 ID Token 里不会带用户组信息。

## [0.2.25] - 2026-08-28

### 新增

- 新增独立的登录页面：`/auth/login` 不再直接 302 跳转到 Authentik，而是渲染一个 Sakura 品牌登录页，由用户点击「使用 Authentik 登录」后再经 `/auth/start` 发起 OIDC 授权。这样退出登录后停留在自己的登录页，不会因 Authentik SSO Cookie 仍然有效而被瞬间静默登录、又直接回到后台。登录页会显示「登录状态已过期」「已退出登录」等提示，并在跳转时保留 `return_to` 目标（仅允许本站相对路径）。

## [0.2.24] - 2026-08-28

### 新增

- 支持 OIDC RP-Initiated Logout：点击后台「退出登录」时，除撤销本地 Web 会话外，还会跳转到 Authentik 的 `end_session_endpoint` 结束 SSO 会话，避免退出后立即被静默续登、又直接进入后台。安装向导的 Authentik 步骤会自动从 OpenID Configuration 回填 `end_session_endpoint`，管理后台「身份认证」表单也新增「登出地址（End Session，可选）」字段；未配置时按 Authentik 惯例回退到 `<issuer>/end-session/`。

### 变更

- 将更新日志（CHANGELOG）改写为中文。

### 升级提示

- 需在 Authentik 的 OAuth2/OIDC Provider 中把 `https://<你的 MCP 域名>/auth/login` 加入 post-logout redirect URI，否则 Authentik 会拒绝 `post_logout_redirect_uri` 参数。

## [0.2.23] - 2026-08-28

### 变更

- 重构安装向导的 AI 模型步骤，将对话（Chat）和向量（Embedding）模型改为分别显式配置，并新增「向量与对话使用同一服务（同站配置）」勾选框：勾选时两者共用同一端点，取消勾选时切换为完全独立的 OpenAI-compatible 向量端点（独立的 Base URL、API Key 和模型）。

## [0.2.22] - 2026-08-27

### 新增

- 新增独立的向量（Embedding）Provider，向量生成可指向与对话 Provider 不同的 OpenAI-compatible 端点（独立的 Base URL、API Key 和模型），可在安装向导和管理后台配置。同时支持新的 `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY` 和 `EMBEDDING_MODEL` 环境变量默认值。
- 向量生成和记忆抽取失败时，在错误信息中附带上游 OpenAI-compatible 服务返回的错误内容，而非仅显示 HTTP 状态码，便于诊断诸如「不支持的向量模型」等 4xx 原因。

## [0.2.21] - 2026-08-27

### 修复

- 使安装页面的本地化断言与当前的 Issuer、Audience 标签保持一致，让 CI 和自动化 Release 打包顺利完成。

## [0.2.20] - 2026-08-27

### 新增

- 安装阶段使用无效授权码的安全 PKCE Token Endpoint 预检来验证 Authentik Public Client 行为，仅接受 `invalid_grant`。
- 新增系统管理员 Authentik 恢复 API 和管理页面，用于测试并事务性地保存身份认证配置。
- 支持在文档说明的、受访问限制的 `AUTH=false` 恢复流程，用于因 Authentik 配置损坏而无法登录的实例。

### 修复

- 当 Authentik 返回 `invalid_client`（包括 Confidential Client、错误的 Client ID 或不支持的认证方式配置）时，阻止安装完成。

## [0.2.19] - 2026-08-27

### 修复

- 在回调失败时展示经过长度限制和净化处理的 Authentik OAuth Token Endpoint `error` 和 `error_description` 值。
- 为 `invalid_client` 提供可操作的 Public Client 指引，为 `invalid_grant` 提供回调地址/重新登录的指引，且不泄露 request ID 或 Token 响应中的机密信息。

## [0.2.18] - 2026-08-27

### 新增

- 支持直接在公网根地址上接收 MCP Streamable HTTP 请求，同时保留 `/mcp` 作为兼容端点。
- 普通浏览器根请求跳转到安装/管理页面，并通过请求方法、SSE Accept 头、授权头、协议版本或会话头识别 MCP 请求。
- 为根地址和旧版 MCP 资源地址发布 RFC 9728 protected-resource 元数据。

## [0.2.17] - 2026-08-27

### 变更

- 将 Authentik 向导的标签和占位文本本地化为中文，在有助于排查问题处保留括号中的标准 OAuth/OIDC 术语。

## [0.2.16] - 2026-08-27

### 新增

- 在首次安装向导中新增 Authentik OpenID Connect 自动发现，使用 HTTPS Authentik 地址和应用 Slug。
- 在输入短暂防抖后自动获取 `/application/o/<slug>/.well-known/openid-configuration`，并提供手动重试按钮。
- 从校验过的发现元数据回填 Issuer、JWKS、授权、令牌和 UserInfo 端点，Audience 和 Client ID 仍需显式填写。

### 安全

- 服务端获取发现元数据时禁止重定向、限制 JSON 响应大小，并拒绝返回的不安全或跨源端点。

## [0.2.15] - 2026-08-27

### 新增

- 新增 `AUTH=false` 和小写 `auth=false` 支持，用于明确受访问限制的单用户部署。
- 认证禁用时，在首次安装向导中跳过 Authentik 步骤。
- 无认证模式下提供稳定的本地系统管理员、个人记忆空间和全权限 MCP 主体。
- 在健康检查响应和管理后台中显示当前的认证模式。

### 安全

- 认证默认保持启用。无认证模式激活时后台会显示永久警告，因为任何网络访问者都将获得完整管理员权限。
- 即使外部身份认证被禁用，管理写请求仍保留 CSRF 校验。

## [0.2.14] - 2026-08-27

### 修复

- GET 或无请求体的管理请求不再发送 `Content-Type: application/json`。否则 MCP/Hono 请求解析器会在路由处理前以 `HTTP 400 Invalid JSON` 拒绝这些请求。
- 在安装向导和管理后台中展示经过长度限制的上游纯文本错误，而非替换为通用的非 JSON 提示。

## [0.2.13] - 2026-08-27

### 变更

- 移除首次安装的 Setup Token 要求。未安装的实例直接进入向导并自动运行环境诊断；已完成的安装仍永久锁定。
- 停止生成、导出和代理 `SETUP_TOKEN`，同时完全兼容现有的运行时密钥卷。

### 新增

- 在管理后台显示当前运行版本，并允许系统管理员检查 GitHub 最新 Release。
- Release 检查缓存 15 分钟、支持手动刷新，并向 HTTP 健康检查、安装状态和 MCP 服务元数据暴露同一个共享版本常量。

### 修复

- 替换健康检查响应、安装记录和 MCP 协议元数据中过时的硬编码 `0.2.2` 值。

## [0.2.12] - 2026-08-26

### 修复

- 为每个 Nginx 上游路由保留公网 `Host`、转发协议和客户端地址，使应用的 Host 校验不再拒绝安装请求。
- 将安装向导 JavaScript 作为同源外部资源提供并使用事件监听器绑定动作，在宝塔/Nginx 施加严格 Content Security Policy 时保持向导可用。
- 接受原始 Setup Token 或粘贴的 `SETUP_TOKEN=...` 行，并显示明确的加载、超时、网络和 HTTP 状态反馈。

## [0.2.11] - 2026-08-26

### 修复

- 让 Compose 回归测试校验带版本的 GHCR 镜像模式，而非过时的硬编码 patch 标签。

## [0.2.10] - 2026-08-26

### 修复

- 为安装环境检查添加可见的加载状态和 15 秒超时反馈。
- 在 Nginx 安装 API 代理中显式转发 `X-Setup-Token`。

## [0.2.9] - 2026-08-26

### 修复

- 默认使用宿主机端口 3001，避免与占用宿主机 3000 端口的 LibreChat 冲突。
- 保持容器内部应用端口为 3000，并通过 `MCP_HOST_PORT` 使宿主机端口可配置。

## [0.2.8] - 2026-08-26

### 修复

- 在 Portainer/宝塔 Compose 部署中，从应用入口使用稳定的 PostgreSQL 容器主机名。
- 保留 PostgreSQL DNS 重试行为，同时避免仅依赖临时的 Compose 服务别名。

## [0.2.7] - 2026-08-26

### 修复

- 在完成无 `.env` bootstrap 和 PostgreSQL 重试修复后，对齐 Compose 回归测试和生产镜像标签。

## [0.2.6] - 2026-08-26

### 修复

- 发布无 `.env` Compose bootstrap 和 PostgreSQL 启动重试修复，并附带最终对齐的 Compose 回归测试。

## [0.2.5] - 2026-08-26

### 修复

- 将 Compose 版本回归测试与 `0.2.4` 的启动重试镜像变更对齐，并发布干净的 Release 标签。
- 将 `0.2.5` 作为推荐的无 `.env` Compose 镜像。

## [0.2.4] - 2026-08-26

### 修复

- 在应用启动时重试 PostgreSQL 的 DNS/连接失败，避免在 Compose 并发启动服务时进入重启循环。
- 为面板管理的部署添加显式的 Compose 网络和 `postgres` 服务别名。

## [0.2.3] - 2026-08-26

### 修复

- 转义无 `.env` Compose bootstrap 脚本中的 shell 变量，使 Docker Compose 不再对未设置的 `value` 变量发出警告。
- Bootstrap 生成的密钥在多次启动间得以保留，并由非 root 应用容器安全加载。

## [0.2.2] - 2026-08-26

### 变更

- 生产 Compose 可在没有预先创建的 `.env` 文件时启动。
- 一次性的 `bootstrap-secrets` 容器在私有 Docker 卷中生成并持久化运行时密钥。
- PostgreSQL 使用 `POSTGRES_PASSWORD_FILE`；应用通过只读密钥卷读取生成的密钥。
- 默认 GHCR 镜像改为 `ghcr.io/guyao146/sakura-mcp-server:0.2.2`。
- 保留 Windows PowerShell 和 Linux 首次安装脚本以支持特定场景的部署。

## [0.2.1] - 2026-08-26

### 新增

- 面向 `linux/amd64` 和 `linux/arm64` 的公开 GHCR 多平台容器发布工作流。
- 从带版本的远程镜像进行生产 Compose 部署。
- 独立的 `docker-compose.dev.yml` 用于本地源码构建。
- Linux 安装脚本支持远程镜像模式和显式的 `--local-build` 模式。

### 变更

- 生产镜像默认使用 `0.2.1` GHCR 标签。
- 生产运行时使用 Debian slim Node 镜像和非 root 的 Debian 用户。

## [0.2.0] - 2026-08-26

### 新增

- 支持基于角色访问控制的多用户个人和共享记忆空间。
- 使用 Authorization Code + PKCE 的 Authentik OAuth/OIDC 登录。
- 基于数据库的 Agent 密钥，支持 scope、到期、撤销和按空间授权。
- PostgreSQL + pgvector 记忆存储、版本、来源、关系和反馈。
- OpenAI-compatible 和 Ollama 的对话/向量 Provider。
- 全文和语义混合召回，并保证不同向量维度的安全性。
- 自动候选提取、重复检测和人工冲突处理。
- 可移植的 JSON/Markdown 导入导出。
- MCP Tools 和 `memory://` Resources。
- 安全的 Web 管理后台和首次安装向导。
- PostgreSQL 后台队列，支持并发领取、恢复、重试和取消。
- 空间级向量重建任务。
- 按租户过滤的 PostgreSQL 审计日志，带 JSONL 回退和递归脱敏。
- HTTP 安全头、分级限流和详细的健康检查。
- 带 pgvector 和容器加固的 Docker Compose 部署。
- 带真实 PostgreSQL 集成测试、npm audit、Docker 构建和 Trivy 扫描的 CI。

### 变更

- 产品定位从特定项目集成转向通用 AI 长期记忆平台。
- MCP 传输改为按请求无状态，防止跨主体的会话复用。

### 安全

- Provider 密钥使用 AES-256-GCM 静态加密。
- Agent 和 Web Session Token 仅以 SHA-256 哈希存储。
- CSRF 保护与每个 Web Session 绑定。
- 审计元数据对凭据和记忆正文进行脱敏。
- 在仓储层和 SQL 查询层强制执行跨空间、跨用户的访问控制。

## [0.1.0] - 2026-08-25

- 初始的安全 Streamable HTTP MCP 服务骨架。
- API Key 和 Authentik JWT 资源服务器认证。
- Docker、Nginx、CI 和自动 GitHub Release 工作流。
