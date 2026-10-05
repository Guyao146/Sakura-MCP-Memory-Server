param(
  [Parameter(Position = 0)]
  [string]$PublicUrl,
  [switch]$LocalBuild
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path '.\docker-compose.yml') -or -not (Test-Path '.\.env.example')) {
  throw '请在 Sakura-MCP-Memory-Server 仓库根目录执行此脚本。'
}

if (Test-Path '.\.env') {
  throw '.env 已存在。为避免覆盖现有密钥，脚本已停止；请备份后手动处理。'
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw '未找到 Docker Desktop/Docker，请先安装 Docker。'
}

docker compose version | Out-Null

if ([string]::IsNullOrWhiteSpace($PublicUrl)) {
  $PublicUrl = Read-Host '请输入 MCP 公网 HTTPS 地址，例如 https://mcp.example.com'
}

if ($PublicUrl -notmatch '^https://[^/]+$') {
  throw '公网地址必须是类似 https://mcp.example.com 的 HTTPS 地址。'
}

function New-Base64UrlSecret([int]$ByteCount) {
  $bytes = New-Object byte[] $ByteCount
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($bytes) }
  finally { $random.Dispose() }
  return [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function Set-EnvLine([string[]]$Lines, [string]$Name, [string]$Value) {
  return $Lines | ForEach-Object {
    if ($_ -match "^$([regex]::Escape($Name))=") { "$Name=$Value" } else { $_ }
  }
}

$databasePassword = New-Base64UrlSecret 48
$encryptionKey = New-Base64UrlSecret 32
$bootstrapSecret = New-Base64UrlSecret 48

Copy-Item '.\.env.example' '.\.env'
$lines = Get-Content '.\.env'
$lines = Set-EnvLine $lines 'PUBLIC_BASE_URL' $PublicUrl
$lines = Set-EnvLine $lines 'POSTGRES_PASSWORD' $databasePassword
$lines = Set-EnvLine $lines 'DATABASE_URL' "postgresql://sakura:$databasePassword@postgres:5432/sakura_memory"
$lines = Set-EnvLine $lines 'CONFIG_ENCRYPTION_KEY' $encryptionKey
$scopes = 'memory:read|memory:write|memory:update|memory:delete|memory:export|space:create|space:manage|member:manage|agent:manage|admin:system'
$lines = Set-EnvLine $lines 'MCP_API_KEYS' "bootstrap-admin:${bootstrapSecret}:$scopes"
Set-Content '.\.env' $lines -Encoding utf8

New-Item -ItemType Directory -Force '.\data' | Out-Null

if ($LocalBuild) {
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
} else {
  docker compose pull sakura-mcp-memory postgres
  docker compose up -d
}

Write-Host ''
Write-Host '部署已启动。'
Write-Host "安装向导：$PublicUrl/setup"
Write-Host "健康检查：$PublicUrl/health"
Write-Host ''
Write-Host '.env 已创建。请安全备份 CONFIG_ENCRYPTION_KEY，不要提交 .env。'
if ($LocalBuild) { Write-Host '本次使用本地构建模式；生产环境建议不使用 -LocalBuild。' }