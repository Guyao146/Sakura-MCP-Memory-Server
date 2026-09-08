# Sakura-MCP-Server

**Sakura-MCP-Server** 是面向所有兼容 MCP 的 AI Agent 的多用户长期记忆平台。Claude、Cline、Cursor、Windsurf 及其他 Agent 可以在经过授权后，把事实、偏好、人物、事件、任务、项目、文档摘要和对话结论写入同一个可治理的记忆库，并在未来的会话中召回。

它不是某几个项目的专用网关。外部系统只会作为可选 Connector 接入通用记忆模型。

## 产品目标

- **跨 Agent 共享**：不同 AI Agent 使用相同 MCP URL 和各自的凭据访问长期记忆。
- **完整多用户**：每个用户都有个人空间，也可以创建共享空间并邀请成员。
- **可治理**：记忆包含来源、版本、重要性、置信度、敏感级别、有效期和删除状态。
- **可检索**：PostgreSQL 全文检索与 pgvector 语义检索组成混合召回。
- **自动整理**：可按空间开启记忆提取、合并和冲突检测。
- **隐私可选**：同时支持 OpenAI-compatible API 和本地 Ollama。
- **不锁定数据**：保留原始内容，支持导入、导出、备份和重新生成向量。

## v0.2.0 架构

```text
任意 MCP Agent                 Web 管理后台
      │                              │
      └──── HTTPS / Authentik ──────┘
                     │
            Sakura-MCP-Server
             ├─ MCP Streamable HTTP
             ├─ 用户 / 空间 / 成员 / Agent 权限
             ├─ 记忆版本、来源、关系、冲突与审计
             ├─ 自动整理 Worker
             ├─ OpenAI-compatible Provider
             └─ Ollama Provider
                     │
             PostgreSQL + pgvector
```

## 多租户权限

每个用户首次通过 Authentik 登录时自动创建个人空间。共享空间支持：

| 角色 | 能力 |
| --- | --- |
| `owner` | 管理空间、成员和所有记忆 |
| `admin` | 邀请成员、管理设置和记忆 |
| `editor` | 创建并编辑记忆 |
| `contributor` | 创建记忆 |
| `viewer` | 只读检索 |

Agent/API Key 的 scopes 与空间角色取交集；仅知道 `memory_id` 或 `space_id` 不能绕过权限。

核心 scopes：

```text
memory:read memory:write memory:update memory:delete memory:export
space:create space:manage member:manage agent:manage admin:system
```

### Agent API Key

正式 Agent Key 保存在 PostgreSQL，而不是共享 `.env` 密钥：

```text
agent_create              创建 Key，返回明文 token
agent_list                查看前缀、scope、到期、撤销和空间授权
agent_delete              删除 Key，立即永久失效
agent_grant_space         授予指定空间和空间级 scopes
agent_revoke_space        移除指定空间授权
```

Token 形如 `sk_sakura_<prefix>_<random-secret>`。数据库保存完整 token 的 SHA-256 哈希（用于认证）、非敏感前缀，以及用 `CONFIG_ENCRYPTION_KEY` 加密（AES-256-GCM）的 token 副本，因此可以在管理后台的「Agent 密钥」列表中点击「查看密钥」随时再次查看，不必在创建时就抄下来。认证始终只比对哈希，加密副本仅用于展示；每次查看都会写入审计日志。0.2.28 之前创建的 Key 没有加密副本，无法再次查看，需要删除后重新创建。

认证时同时校验：

```text
Agent 全局 scopes
∩ Agent 对目标空间的 grants
∩ Agent 所属用户在目标空间的成员角色
```

Agent 只能列出明确授权的空间；撤销后下一次请求立即失效。创建、授权和撤销 Agent Key 必须由交互式管理员（Authentik 用户或 `AUTH=false` 的本地管理员）执行，Agent 不能自行创建子 Key。

## MCP Tools

当前核心工具：

```text
memory_remember             写入结构化长期记忆
memory_search               全文 + pgvector 混合搜索与过滤
memory_recall               根据当前上下文进行语义召回
memory_get                  获取单条记忆
memory_update               更新并保留版本
memory_forget               软删除或管理员永久删除
memory_extract              从文本提取候选长期记忆（不保存）
memory_extract_and_remember 从文本提取并保存长期记忆
memory_conflicts            查询待处理/已解决/已忽略冲突
memory_resolve_conflict     保留、合并或忽略冲突记忆
memory_link                 建立同空间记忆关系
memory_feedback             记录召回是否有用及纠正意见
memory_import               导入 JSON/Markdown 并返回任务摘要
memory_import_status        查询导入任务与逐条错误
memory_export               导出可迁移 JSON/Markdown
embedding_rebuild_start      后台重建空间全部有效记忆向量
background_job_list          查询空间后台任务
background_job_status        查询任务进度和错误
background_job_cancel        请求取消任务
background_job_retry         重试失败/已取消任务
audit_list                   查询当前身份可见的安全审计事件
space_list                  列出个人与共享空间
space_create                创建共享空间
space_list_members          查看成员与角色
space_invite_member         创建限时、一次性邀请
space_accept_invitation     Authentik 邮箱匹配后接受邀请
agent_create                创建 Agent Key
agent_list                  列出 Agent 与空间授权
agent_delete                删除 Agent Key
agent_grant_space           配置空间级权限
agent_revoke_space          移除空间级权限
```

后续工具将聚焦异步重建、审计查询和大型文档分块。

## 记忆数据模型

每条记忆属于一个空间，并包含：

```text
type / content / summary / tags
importance / confidence / sensitivity
valid_from / valid_until / expires_at
source / source_agent / source_uri
status / supersedes_id
created_by / created_at / updated_at / last_accessed_at
embedding / relations / versions / feedback
```

数据库迁移位于 `migrations/`，已覆盖用户、空间、成员、邀请、Agent 凭据、Provider、记忆、向量、版本、来源、关系、冲突、反馈、导入任务和审计日志。

## AI Provider

### OpenAI-compatible

支持 `/chat/completions` 与 `/embeddings`：

```dotenv
OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1
OPENAI_COMPATIBLE_API_KEY=
OPENAI_COMPATIBLE_CHAT_MODEL=
OPENAI_COMPATIBLE_EMBEDDING_MODEL=
```

### Ollama

支持 `/api/chat` 与 `/api/embed`：

```dotenv
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_CHAT_MODEL=
OLLAMA_EMBEDDING_MODEL=
```

### 独立向量服务（Embedding）

当对话中转站不提供 `/embeddings` 时，可单独配置一个 OpenAI-compatible 向量服务。它拥有独立的 Base URL、API Key 和模型，与对话 Provider 完全分离。配置后向量优先走此服务，对话继续走原 Provider：

```dotenv
EMBEDDING_BASE_URL=https://vectors.example.com/v1
EMBEDDING_API_KEY=
EMBEDDING_MODEL=
```

也可以在安装向导的“AI 模型服务”步骤或管理后台“模型 Provider”页面单独填写和测试。留空则沿用对话 Provider 生成向量。

每个空间最终可独立选择 Provider、模型和是否启用自动提取。更换 embedding 模型时通过后台任务重新生成向量；模型调用失败不丢失原始记忆。

### 混合检索

配置空间的 Embedding Provider 后，`memory_search` 和 `memory_recall` 使用以下混合评分：

```text
60% 向量余弦相似度
25% PostgreSQL 全文相关度
10% 记忆重要性
 5% 记忆置信度
```

未配置 Provider、模型服务不可用或查询向量失败时，会明确回退到全文检索。创建和更新记忆时会生成/重建向量；失败会把 `memory_embeddings.status` 标记为 `failed` 并记录错误，但原始记忆、来源和版本不会丢失。

空间 AI 策略可在 Web 管理台配置：

- Provider 类型；
- Chat Model；
- Embedding Model；
- 自动提取；
- 自动合并；
- 冲突检测；
- 隐私模式。

隐私模式只允许本地 Ollama，拒绝把内容发送至 OpenAI-compatible Provider。不同空间可以使用不同维度的向量，因此当前使用精确 pgvector 检索；后续将按 Provider/模型/维度分区建立 HNSW 索引。

## 记忆治理

自动提取后的新记忆可按空间策略执行治理：

- 规范化内容完全相同：建立 `duplicate_of` 关系；
- 同维度向量相似度达到阈值：创建潜在冲突，等待人工确认；
- 不会仅凭模型或相似度自动删除旧事实；
- 开放状态下同一对记忆只允许一个冲突记录；
- 关系只能建立在同一空间，禁止自关联。

冲突支持四种处理：

```text
keep_a   保留 A，B 标记为 superseded
keep_b   保留 B，A 标记为 superseded
merge    将人工确认后的合并内容写入 A，B 标记为 superseded
dismiss  认为不存在冲突，保留两条记忆
```

所有替代和合并操作保留原记忆、来源、关系及版本历史，不进行物理删除。Web 管理后台提供“冲突确认”页面；冲突解决要求人工 Authentik 用户，Agent 不能自行裁决事实。`memory_feedback` 可记录某条召回是否有帮助及纠正内容，为后续排序优化提供依据。

## 导入、导出与 MCP Resources

支持 JSON 和 Markdown。单次导入最多 500 条、正文最多 5 MB；每条独立校验，一条失败不会回滚其他有效记忆。导入复用空间权限、Embedding 和治理，`ingestion_jobs` 保存总数、成功、失败及最多 100 条错误摘要。导出不包含 Provider API Key、OIDC Token、Session 或 Agent Secret。

支持资源浏览的 MCP 客户端可以读取：

```text
memory://spaces                    当前身份可访问的空间
memory://spaces/{spaceId}          空间和最近 100 条有效记忆
memory://memories/{memoryId}       单条结构化记忆
```

Resource URI 不是权限凭据；每次读取仍校验 Bearer 身份、Agent grant、空间成员关系和 `memory:read` scope。Web 管理台“记忆管理”页面提供导入、导出 JSON 和导出 Markdown。当前同步完成并记录任务，后续大文件会沿用同一任务协议迁移到 Worker。

## PostgreSQL 后台 Worker

服务内置持久化 Worker，首个任务类型是空间 Embedding 批量重建。任务使用 PostgreSQL `FOR UPDATE SKIP LOCKED` 原子领取，因此多副本部署不会重复消费同一任务。任务记录包含：

```text
job_type / payload / status
attempts / max_attempts / available_at
locked_at / locked_by / cancel_requested
total / completed / failed / errors
```

处理实例崩溃后，超过 `WORKER_STALE_AFTER_SECONDS` 的 processing 任务会自动回到队列。失败任务按指数退避自动重试，达到最大次数后标记 `failed`；用户也可取消和手工重试。取消是协作式的，Worker 每处理完一条记忆检查一次取消标记。

```dotenv
WORKER_ENABLED=true
WORKER_POLL_INTERVAL_MS=2000
WORKER_STALE_AFTER_SECONDS=900
```

Web 管理后台新增“后台任务”页面，可以按空间发起向量重建、查看进度、取消和重试。队列操作始终要求空间成员关系；发起、取消和重试要求空间 `admin`，只读查看要求 `viewer`。

## 安全审计

MCP Tools、Web 管理 API、安装、Authentik 登录/退出统一写入 PostgreSQL `audit_logs`，同时保留本机 JSONL 作为应急副本。审计记录包含用户、Agent、空间、认证来源、动作、目标、结果、request ID 和时间。

敏感字段会递归脱敏，包括：

```text
token / secret / password / apiKey
authorization / cookie / code_verifier / nonce
content / excerpt
```

长字符串截断到 500 字符，数组最多保留 100 项，嵌套深度受限。审计系统不会记录记忆正文、导入正文、Provider 密钥、Session 或 OIDC Token。审计写入使用 best-effort：审计存储临时失败不会把已经提交的业务事务错误地返回为失败。

审计可见性：

- 普通用户可看自己的活动；
- 空间 owner/admin 可看该空间活动；
- viewer/editor/contributor 不能借空间成员关系查看他人审计；
- 系统管理员可查看全局审计；
- SQL 查询层强制租户过滤，不能通过猜测事件 ID 绕过。

Web 管理后台新增“审计日志”页面，支持空间、动作、结果筛选及游标分页。MCP 的 `audit_list` 复用相同过滤规则。

## Docker 部署

要求 Docker Compose v2，编排包含 PostgreSQL 16 + pgvector 与 MCP 服务。仓库提供了安全的 Linux 首次安装脚本，会自动生成随机数据库密码、安装令牌和配置加密主密钥；密钥只写入本机 `.env`，不会进入 Git。

### 一键初始化（Linux）

```bash
git clone https://github.com/Guyao146/Sakura-MCP-Server.git
cd Sakura-MCP-Server
chmod +x scripts/install.sh
./scripts/install.sh https://mcp.example.com
```

Windows PowerShell / Docker Desktop：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1 -PublicUrl https://mcp.example.com
```

本地源码构建模式：

```powershell
.\scripts\install.ps1 -PublicUrl https://mcp.example.com -LocalBuild
```

也可以不传参数，脚本会交互询问 HTTPS 地址：

```bash
./scripts/install.sh
```

脚本会执行：

1. 检查 Docker 和 Compose v2；
2. 拒绝覆盖已有 `.env`；
3. 生成随机数据库密码、`CONFIG_ENCRYPTION_KEY` 和 bootstrap API Key；
4. 创建权限为 `600` 的 `.env` 和 `700` 的 `data/`；
5. 拉取 GHCR 镜像并执行 `docker compose up -d`；
6. 输出安装向导和健康检查地址。

脚本不会输出任何生成的 Secret。执行后请先配置 HTTPS Nginx，再访问 `/setup`。

### 手工部署

如果不使用初始化脚本，仍可手工配置：

```bash
cd Sakura-MCP-Server
# Compose 不会自动读取 .env.example，必须先创建 .env
cp .env.example .env
# 修改数据库密码、PUBLIC_BASE_URL，并生成 CONFIG_ENCRYPTION_KEY
chmod 600 .env
docker compose pull
docker compose up -d
```

`docker-compose.yml` 是生产编排文件，默认直接拉取：

```text
ghcr.io/guyao146/sakura-mcp-server:0.3.2
```

如果 GHCR Package 设置为 Public，服务器无需 `docker login`。首次发布后请在 GitHub 仓库的 **Packages → sakura-mcp-server → Package settings** 中确认可见性为 **Public**。

本地开发需要构建源码时使用：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

### 只下载 Compose 的远程编排

如果服务器不想克隆完整仓库，可以只下载生产 Compose 和环境模板，直接拉取 GHCR 镜像：

```bash
mkdir -p /opt/sakura-mcp-server
cd /opt/sakura-mcp-server
curl -fsSLO https://raw.githubusercontent.com/Guyao146/Sakura-MCP-Server/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/Guyao146/Sakura-MCP-Server/main/.env.example
cp .env.example .env
# 填写密钥和 PUBLIC_BASE_URL
mkdir -p data && chmod 700 data && chmod 600 .env
docker compose pull
docker compose up -d
```

生产 Compose 不需要本地 Dockerfile、Node.js、npm 或完整源码。镜像版本通过 `.env` 覆盖：

```dotenv
SAKURA_MCP_IMAGE=ghcr.io/guyao146/sakura-mcp-server:0.3.2
```

如果需要固定到其他已发布版本，只需修改 `SAKURA_MCP_IMAGE`，然后执行 `docker compose pull && docker compose up -d`。

Compose 默认：

- 应用默认绑定 `127.0.0.1:3001`，转发到容器内部 `3000`；
- PostgreSQL 只在 Compose 内部网络；
- `host.docker.internal` 映射到 Docker 宿主机，便于访问宿主机 Ollama；
- PostgreSQL 数据保存在命名卷 `sakura-mcp-server_postgres-data`；
- 审计 JSONL 保存在当前目录 `data/`；
- 应用使用只读文件系统、非 root 用户、丢弃全部 Linux capabilities 和 PID 限制；
生产 Compose 只拉取 GHCR 镜像，源码构建仅由 `docker-compose.dev.yml` 覆盖启用。

### 无 `.env` 直接启动

生产 `docker-compose.yml` 现在可以在没有 `.env` 的目录直接执行：

```bash
docker compose up -d
```

注意：Docker Desktop/Portainer 的项目变量中如果填写了旧的 `POSTGRES_PASSWORD` 或 `MCP_API_KEYS`，它们只会用于首次创建 `runtime-secrets`；已有 secret 卷不会被覆盖。升级前不要删除该 Compose 项目的 `runtime-secrets` 卷。旧版本卷中即使仍有 `SETUP_TOKEN`，新版也会忽略它。

Compose 会先启动一次性 `bootstrap-secrets` 容器，自动生成并保存：

```text
PostgreSQL 密码
CONFIG_ENCRYPTION_KEY
bootstrap Agent Key
```

生成的密钥只保存在 Docker 命名卷 `runtime-secrets`，应用以只读方式挂载。这样 Docker Desktop、Portainer 或直接上传 Compose 文件时不会再因为缺少 `POSTGRES_PASSWORD` 而创建失败。

首次启动后直接访问 `/setup`，页面会自动检查 PostgreSQL、pgvector 和迁移，无需读取或输入安装 Token。安装完成前，任何能访问 `/setup` 的人都可以发起首次安装；建议在宝塔/Nginx 中临时限制为管理员 IP，并尽快完成安装。安装完成后 Setup API 永久返回 `410 setup_locked`。

如果要设置域名、Provider 或其他非密钥配置，可以在 Compose 项目环境变量中填写，或者在同目录创建 `.env`。`.env` 中提供的密钥只会在第一次初始化 secret 卷时使用；已有 secret 卷不会被覆盖。

查看安装向导地址：

```text
http://localhost:3001/setup
```

生产环境仍建议先配置 HTTPS Nginx，然后访问 `https://你的域名/setup`。

手工生成配置加密密钥：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```dotenv
CONFIG_ENCRYPTION_KEY=<生成的值>
```

`CONFIG_ENCRYPTION_KEY` 是长期主密钥，必须离线备份。丢失后，数据库中已加密的模型 API Key 无法恢复。

启动后访问：

```text
https://mcp.example.com/setup
```

## 安装向导

### 可选的无认证模式

认证默认启用。仅当 Sakura-MCP-Server 位于已通过防火墙、VPN 或反向代理白名单限制访问的私有网络时，可以在 `.env` 或宝塔 Compose 环境变量中设置：

```dotenv
AUTH=false
```

同时兼容用户指定的小写写法：

```dotenv
auth=false
```

任意一个变量明确为 `false` 都会启用单用户无认证模式。在此模式下：

- 安装向导自动跳过 Authentik 配置和连接测试；
- `/admin` 无需登录，使用稳定的 `Local Administrator` 系统管理员身份；
- 根域名和兼容地址 `/mcp` 均无需 Bearer Token，使用同一本地身份和完整 scopes；
- 管理写请求仍使用 CSRF Token；
- 管理后台会永久显示红色安全警告；
- 任何能连接该站点的人都拥有完整管理和记忆访问权限。

公网部署不要设置 `AUTH=false`。已完成安装的实例可以通过修改该变量并重启容器切换模式；从无认证模式恢复 `AUTH=true` 前，必须确保数据库或环境变量中已有完整 Authentik 配置，否则浏览器登录不可用。

首次启动的中文 Web 安装向导包含四个步骤：

1. 页面自动检查 PostgreSQL、pgvector 与迁移；
2. `AUTH=true` 时配置并测试 Authentik Issuer、Audience、JWKS 和首位管理员邮箱；`AUTH=false` 时自动跳过；
3. 可选配置并测试 OpenAI-compatible 或 Ollama；
4. 确认配置加密密钥已备份，完成安装并锁定向导。

`AUTH=true` 的 Authentik 步骤支持 OpenID Connect 自动发现。只需填写：

```text
Authentik 地址：https://login.example.com
应用名称（Application Slug）：sakura-mcp
```

向导在停止输入约 600ms 后自动由服务端请求：

```text
https://login.example.com/application/o/sakura-mcp/.well-known/openid-configuration
```

并回填签发者地址、签名密钥地址、授权地址、令牌地址、用户信息地址和登出地址；也可以点击“获取 OpenID 配置”手动重试。基础地址必须是无路径、无凭据的 HTTPS 根地址，应用 Slug 只允许字母、数字、下划线和连字符。OIDC 自动发现不包含部署专属的令牌受众和客户端 ID，这两项仍需按 Authentik 提供方配置手动填写。

### 系统管理员的授予方式

系统管理员可以管理模型 Provider、Authentik 配置和版本更新。有三种授予途径，满足其一即可：

- **Authentik 超级用户（默认生效，无需配置）**。ID Token 的 `groups` 声明包含 `authentik Admins` 即为系统管理员。Authentik 默认的 `profile` 权限映射本身就会返回用户所属用户组名称，因此 Authentik 的管理员登录后自动就是 Sakura 的系统管理员。
- 安装时填写的系统管理员邮箱。该邮箱写入白名单，登录时与 ID Token 的 `email` 声明比对（忽略大小写），始终保留管理员权限。
- 自定义「管理员用户组」。在安装向导或后台「身份认证」中填写用户组名称，多个用英文逗号分隔。一旦填写就完全替代内置的 `authentik Admins`，并成为权威判据：命中即管理员，未命中则回收管理员身份，因此在 Authentik 侧调整用户组后下次登录立即生效。

留空「管理员用户组」时只做提权、不做降权，手工在数据库里授予的管理员不会被回收。若 Provider 移除了默认 `profile` 权限映射导致 ID Token 不含 `groups`，则退回仅用邮箱白名单判断，同样不会误降权。

安装完成前：

- `/setup` 可打开安装页面；
- Setup API 无需安装 Token，但仍受独立频率限制；
- 建议在反向代理中临时限制 `/setup` 和 `/api/setup/` 的来源 IP，直到安装完成；
- 根域名的 MCP 请求和 `/mcp` 均返回 `503 setup_required`，不会在未完成安装时对外提供记忆能力。

安装完成后：

- Setup 配置接口永久返回 `410 setup_locked`；
- `AUTH=true` 时 Authentik 配置从数据库加载；Provider 配置始终从数据库加载；
- OpenAI-compatible API Key 使用 AES-256-GCM 加密存储；
- 浏览器和 API 均不能重新开启安装向导。

Authentik Provider 应使用 Public Client + Authorization Code + PKCE，并注册精确回调地址：

```text
https://mcp.example.com/auth/callback
```

管理后台登录入口：

```text
https://mcp.example.com/auth/login
```

该地址渲染 Sakura 登录页，点击「使用 Authentik 登录」后由 `/auth/start` 发起授权码 + PKCE 流程；这样退出后不会因 SSO Cookie 仍然有效而被立即静默登录。

浏览器会话 Cookie 使用 `HttpOnly`、`SameSite=Lax`，HTTPS 部署下同时使用 `Secure`；数据库只保存 Session Token 的 SHA-256 哈希。退出登录后会话立即撤销，并按 OIDC RP-Initiated Logout 跳转 Authentik 的 `end_session_endpoint` 同步结束 SSO 会话，因此还需在同一个 Provider 中把登录入口注册为 post-logout redirect URI：

```text
https://mcp.example.com/auth/login
```

否则 Authentik 会拒绝 `post_logout_redirect_uri` 参数。

管理后台地址：

```text
https://mcp.example.com/admin
```

如果 Authentik 配置错误导致无法登录管理后台，可执行受控恢复：

1. 先在防火墙、VPN、Cloudflare Access 或 Nginx 中只允许管理员来源；
2. 临时将应用环境变量设置为 `AUTH=false` 并重建应用容器；
3. 打开 `/admin`，进入“身份认证”；
4. 修正 Client ID、Issuer、JWKS、授权/令牌地址和管理员邮箱，点击“测试并保存”；
5. 页面确认 Public Client + PKCE 预检通过后，将 `AUTH=true` 恢复并再次重建应用容器；
6. 从 `/auth/login` 发起全新登录，不要刷新旧的 callback URL。

恢复模式会暂时让所有能够访问站点的人拥有系统管理员权限，禁止在未限制网络访问的公网环境中使用。

当前 Web 管理后台支持：

- 查看个人空间和共享空间；
- 创建共享空间；
- 查看空间成员并生成邮箱绑定的一次性邀请；
- 按空间搜索、创建、编辑和软删除记忆；
- 创建只显示一次的 Agent Key；
- 查看 Agent scope、前缀、到期、使用和撤销状态；
- 为 Agent 配置空间级 scopes；
- 立即撤销 Agent Key；
- 测试、修复并保存 Authentik Public Client 配置；
- 显示当前运行版本，并由系统管理员检查 GitHub 最新 Release。

所有管理 API 都从 HttpOnly Session 解析内部用户身份，不接受客户端传入 `user_id`。写请求还必须提供与 Session ID 绑定的 HMAC-SHA256 CSRF Token；页面中的服务端数据使用 DOM `textContent` 渲染，不将用户内容拼接进 HTML。

如果确需重新安装，应由服务器管理员先完成数据库备份，再通过受控维护流程重置 `installation_state`；不要向 Web 客户端提供“重置安装”按钮。

健康检查：

```bash
curl https://mcp.example.com/health
```

生产环境使用 `nginx-mcp.conf.example` 提供 HTTPS，仅开放 443，不直接暴露 PostgreSQL 和 3001 端口。

生产环境在应用只能由可信 Nginx 访问时设置 `TRUST_PROXY=true`，否则保持默认 `false`，防止客户端伪造 `X-Forwarded-For` 绕过限流。应用提供 CSP、HSTS、点击劫持、MIME sniffing、Referrer 和 Permissions Policy 安全头，并对 MCP、登录、安装和管理 API 使用独立限额。

```dotenv
TRUST_PROXY=true
RATE_LIMIT_MCP_PER_MINUTE=120
RATE_LIMIT_WEB_PER_MINUTE=300
RATE_LIMIT_AUTH_PER_MINUTE=20
RATE_LIMIT_SETUP_PER_MINUTE=10
```

详细升级步骤见 [`docs/upgrade-to-0.2.md`](docs/upgrade-to-0.2.md)，版本变更见 [`CHANGELOG.md`](CHANGELOG.md)。

CI 还会运行 `npm audit --omit=dev --audit-level=high` 作为阻塞式依赖安全检查，并构建 Docker 镜像后运行 Trivy HIGH/CRITICAL 扫描。Trivy 当前为报告模式：扫描结果仍会输出，但不会因上游 Node/Debian 基础镜像的临时 CVE 基线变化阻塞应用测试和 Compose 校验；生产依赖审计仍会阻塞 CI。

## Agent 连接

MCP URL：

```text
https://mcp.example.com
```

旧客户端仍可继续使用兼容地址：

```text
https://mcp.example.com/mcp
```

根路径会按请求类型自动分流：普通浏览器 `GET /` 跳转到安装向导或管理后台；MCP 的 POST、DELETE、SSE GET，以及携带 MCP Header 或 Authorization 的请求会直接进入 Streamable HTTP MCP 处理器。

API Key 客户端使用：

```http
Authorization: Bearer <每个 Agent 独立的密钥>
```

`AUTH=false` 时根域名和 `/mcp` 都不需要 Authorization Header，并统一使用本地管理员身份；这等同于向所有网络访问者开放完整权限，因此只允许在受访问控制的私有网络使用。

支持 OAuth 的客户端通过 RFC 9728 元数据发现 Authentik。根域名推荐地址为：

```text
/.well-known/oauth-protected-resource
```

兼容 `/mcp` 的旧元数据地址为：

```text
/.well-known/oauth-protected-resource/mcp
```

`AUTH=true` 时 Authentik Token 必须有专属于 MCP Server 的 audience；服务不会把用户 Token 透传给模型 Provider。

## 本地开发

要求 Node.js 22+ 和可用的 PostgreSQL + pgvector。

```powershell
cd D:\Sakura-MCP-Server
Copy-Item .env.example .env
npm.cmd install
npm.cmd run check
npm.cmd run build
npm.cmd start
```

## 相关工具

- [`tools/cline-sync`](tools/cline-sync/README.md)：托盘常驻的同步工具，定时读取 Cline 本地对话历史并调用 `memory_extract_and_remember` 自动抽取长期记忆，无需手动触发。

## 当前开发状态

`v0.1.0` 是早期安全 MCP 网关版本；当前 `main` 的应用版本为 `v0.3.2`，对应 GHCR 镜像和生产 Compose 部署版本。

已完成：

- 多租户数据库 Schema 与自动迁移；
- 个人/共享空间、成员角色和邮箱邀请仓库；
- 基础记忆 CRUD、来源、版本、全文检索；
- OpenAI-compatible 与 Ollama Provider；
- 通用记忆和空间 MCP Tools；
- API Key + Authentik JWT 双认证基础。
- 首次启动 Web 安装向导、数据库诊断、Provider 测试和安装锁；
- AES-256-GCM 服务端配置加密；
- 数据库 Agent Key、哈希认证、到期、撤销与空间级 scopes；
- Authentik Authorization Code + PKCE 浏览器登录与哈希 Session；
- Web 管理后台：空间、成员邀请、记忆 CRUD、Agent Key 与空间授权；
- OpenAI-compatible/Ollama Provider 管理与空间级 AI 策略；
- 记忆 Embedding、pgvector 混合检索和故障安全回退；
- LLM 候选记忆提取与批量保存；
- 重复检测、关系、反馈、冲突队列与人工解决；
- JSON/Markdown 导入导出、任务错误报告与 MCP Resources；
- PostgreSQL 持久化 Worker、并发安全领取、取消、重试和批量向量重建；
- PostgreSQL/JSONL 统一安全审计、递归脱敏、租户过滤和审计后台；
- HTTP 安全头、分级限流、可信代理模式、详细健康检查和容器安全扫描；

进行中：

- 大文档异步分块导入和自动合并策略增强；
- 更完整的跨租户越权测试矩阵。

未完成的功能不会以伪造数据或静默降级方式对外宣称可用。

## 自动测试与发布

推送分支会执行类型检查、单元测试和 Docker 构建。推送 `v*` tag 后自动运行测试、生成 npm tarball 并创建 GitHub Release。

## 许可证

GNU Lesser General Public License v2.1，详见 `LICENSE`。