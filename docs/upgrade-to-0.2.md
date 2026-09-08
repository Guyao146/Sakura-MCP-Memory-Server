# Upgrade to Sakura-MCP-Server 0.2.x

Version 0.2.x changes Sakura-MCP-Server into a PostgreSQL-backed multi-user AI memory platform.

## Before upgrading

1. Back up the current `.env` and reverse-proxy configuration.
2. Generate and securely back up a permanent `CONFIG_ENCRYPTION_KEY` value.
3. Provision PostgreSQL 16 with the pgvector extension, or use the included Compose service.
4. When keeping the default `AUTH=true`, configure an Authentik Public OAuth client with Authorization Code + PKCE.
5. For `AUTH=true`, register the exact redirect URI: `https://mcp.example.com/auth/callback`.

## Upgrade

```bash
git pull --ff-only
cp .env.example .env.new
# Merge required values into the existing .env; do not overwrite secrets blindly.
docker compose pull
docker compose up -d
docker compose logs -f sakura-mcp
```

新部署也可以直接运行仓库中的 `scripts/install.sh`。脚本只适用于没有 `.env` 的首次部署，发现已有 `.env` 会停止，不会覆盖现有密钥。

Windows Docker Desktop 用户可以运行 `scripts/install.ps1`；PowerShell 执行策略受限时，先执行 `Set-ExecutionPolicy -Scope Process Bypass`。生产模式会拉取 GHCR 镜像，只有显式传入 `-LocalBuild` 才会本地构建。

生产 `docker-compose.yml` 默认拉取 `ghcr.io/guyao146/sakura-mcp-server:0.3.2`，宿主机默认使用 3001、容器内部使用 3000，不会和 LibreChat 的 3000 冲突。不需要服务器保存源码或安装 Node.js，也不要求预先创建 `.env`。Compose 会由一次性 `bootstrap-secrets` 容器生成持久化运行密钥。源码开发/本地构建请额外使用 `docker-compose.dev.yml`。

首次启动后直接访问 `/setup`，无需安装 Token。页面会自动检查运行环境；安装完成前建议在反向代理中临时限制 `/setup` 和 `/api/setup/` 的来源 IP。请长期备份 `CONFIG_ENCRYPTION_KEY`。从旧版本升级时无需删除 `runtime-secrets`；其中残留的旧 `SETUP_TOKEN` 会被忽略。

认证默认启用。只在防火墙、VPN 或反向代理已经限制访问的私有部署中设置 `AUTH=false`（也兼容 `auth=false`）。该模式会跳过向导中的 Authentik 步骤，并使 `/admin` 和 `/mcp` 对所有网络访问者使用完整权限的本地管理员身份；它不适合公网部署。修改后运行 `docker compose up -d --force-recreate sakura-mcp`。恢复 `AUTH=true` 前必须确保 Authentik 配置完整。

从 0.2.18 起，公网根地址（例如 `https://mcp.example.com`）是推荐 MCP URL；原 `/mcp` 地址继续兼容。普通浏览器访问根地址仍会跳转到 `/setup` 或 `/admin`。`AUTH=true` 时无论使用哪个 MCP 地址都必须携带有效 Bearer 凭据。

从 0.2.20 起，安装向导会使用无效授权码执行安全的 Public Client Token Endpoint 预检：`invalid_grant` 表示客户端身份通过，`invalid_client` 会阻止安装。已安装但无法登录时，先限制网络访问，再临时设为 `AUTH=false`，进入 `/admin` 的“身份认证”页测试并保存，随后恢复 `AUTH=true` 并重启。

With `AUTO_MIGRATE=true`, migrations run in filename order at startup. Do not delete entries from `schema_migrations`.

For a fresh 0.2 deployment, visit `/setup`. An installation already marked complete will return `410 setup_locked` and cannot be reset through the browser.

## Verify

```bash
curl -fsS https://mcp.example.com/health
curl -I https://mcp.example.com/admin
docker compose ps
```

Verify `.env` is mode `600`, host port 3001 is bound only to `127.0.0.1`, PostgreSQL is not published, and HTTPS is mandatory.

## Rollback

Application rollback is possible by deploying an earlier image, but database migrations are forward-only. Before rollback, restore the PostgreSQL backup taken before upgrade. Never attempt to manually remove enum values, columns or migration records from a live database.
