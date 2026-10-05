#!/bin/sh
set -eu

secret_file=/run/sakura-secrets/app.env
if [ ! -r "$secret_file" ]; then
  echo "Sakura-MCP-Memory-Server secret volume is not initialized." >&2
  exit 1
fi

. "$secret_file"
export POSTGRES_PASSWORD CONFIG_ENCRYPTION_KEY MCP_API_KEYS
export POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
export DATABASE_URL="postgresql://sakura:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:5432/sakura_memory"

exec node /app/dist/index.js