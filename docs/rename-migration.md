# 改名迁移：Sakura-MCP-Memory-Server（v0.5.1）

原项目 `Sakura-MCP-Server` 更名为 `Sakura-MCP-Memory-Server`。这是同一项目，Git 历史、Issues、Releases 和旧标签保持不变，不是重新安装。

## 各渠道标识

| 渠道 | 新名称 |
| --- | --- |
| GitHub | https://github.com/Guyao146/Sakura-MCP-Memory-Server |
| npm 格式发布包 | `sakura-mcp-memory-server-0.5.1.tgz`（GitHub Release 附件） |
| GHCR | `ghcr.io/guyao146/sakura-mcp-memory-server:0.5.1` |
| Compose 项目 | `sakura-mcp-memory-server` |
| Compose 应用服务 | `sakura-mcp-memory` |
| 容器 | `sakura-mcp-memory-server-app`、`sakura-mcp-memory-server-postgres` |
| 镜像覆盖变量 | `SAKURA_MCP_MEMORY_IMAGE`，优先于兼容变量 `SAKURA_MCP_IMAGE` |

原 GitHub URL 会重定向，不要另建同名旧仓库破坏重定向。原 GHCR 镜像不会自动重命名；旧路径和旧版本保留供回退，新版本发布到新路径。未在 npm Registry 发布过旧包，本次也不新增 Registry 发布。

## 新安装

使用新仓库和 `v0.5.1` 的 Compose/环境模板。首次启动使用新项目的数据卷名称；镜像可用性以对应 Release/Container Image 工作流及 GHCR 为准。

## 已有安装：先保留数据和密钥，再切换

**禁止直接用新项目名启动、禁止 `docker compose down -v`、禁止重新生成主密钥。** 否则可能连接新建空数据库或失去旧密钥。

1. 在旧部署目录备份数据库、`.env`、Compose、`data` 目录、`runtime-secrets` 卷及原 `CONFIG_ENCRYPTION_KEY`。备份必须受限保管且加密，先完成隔离恢复演练。
2. 记录真实卷名：`docker volume ls`，并用 `docker inspect` 检查现有 PostgreSQL 和应用容器挂载。默认是 `sakura-mcp-server_postgres-data` 和 `sakura-mcp-server_runtime-secrets`；自定义 `-p` / `COMPOSE_PROJECT_NAME` 的部署可能不同。
3. 在**仍使用旧 Compose 的目录**执行 `docker compose stop`，停止旧应用、Worker 和 PostgreSQL。不得让两个 PostgreSQL 实例同时挂载一个数据目录。保留旧 Compose 用于回滚。
4. 获取新版本 Compose 和 `docker-compose.legacy-data.yml`。在原部署目录操作，保留原 `.env` 和相同的 `./data` 绑定目录，不要用示例覆盖密钥。
5. `.env` 中设置新镜像；如果真实旧卷名不是默认值，同时设置两个卷名覆盖变量：

```dotenv
SAKURA_MCP_MEMORY_IMAGE=ghcr.io/guyao146/sakura-mcp-memory-server:0.5.1
SAKURA_MEMORY_POSTGRES_VOLUME=sakura-mcp-server_postgres-data
SAKURA_MEMORY_SECRETS_VOLUME=sakura-mcp-server_runtime-secrets
```

6. 使用外部卷覆盖文件验证并启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.legacy-data.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.legacy-data.yml pull
docker compose -f docker-compose.yml -f docker-compose.legacy-data.yml up -d
```

覆盖文件将**两个卷都设为 external**，任意一个不存在就拒绝启动，不会悄悄创建新卷。后续 `up` / `down` 等命令始终带上该覆盖文件。检查卷名时不要打印 secret 内容；不要将完整 `docker compose config` 输出发到公开日志。

7. 检查 `/health`、用户/空间/记忆/历史数量、Provider/Agent 密钥解密和检索结果。若看见首次安装向导或空数据，立即停止新项目，检查卷映射，而不是重新安装。
8. 数据库及密钥卷仍以旧物理名称复用，这是数据安全兼容，不是对外品牌遗漏。若一定要连卷名也改，必须在停机和独立备份下另行迁移，不能靠字符串替换。

回退时先停止新项目，再用保留的旧 Compose、旧镜像和同一套卷启动。不要同时运行两套；不要删除卷。相比 `v0.5.0`，`v0.5.1` 不新增数据库迁移；更早版本升级仍需执行至迁移 `016`。

## 保持兼容的标识

- MCP `/` 与 `/mcp`、工具名、API 路径、Cookie、`sk_sakura_` Agent Key 前缀及导入/备份格式不变。
- 数据库 `sakura_memory`、用户 `sakura`、schema 和已有数据不改名。
- **已配置的 OIDC issuer、Client ID、audience、回调 URL 不自动改名**；示例中新部署可使用 `sakura-mcp-memory`，旧客户端必须保持与 IdP 配置一致。
- `cline-sync` 是独立工具名称，保持不变，只更新它的服务端名称说明。
- 许可正文、权属、生效日期及历史授权不因改名变化；采用声明更新项目身份。
- 生态 Wiki 新页面保留旧地址兼容入口；第三方收藏、搜索引擎缓存与外部用户部署无法自动改写。
