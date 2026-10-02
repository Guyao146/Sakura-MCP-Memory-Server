FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY scripts/container-entrypoint.sh ./container-entrypoint.sh
COPY scripts/healthcheck.mjs ./healthcheck.mjs
RUN chmod 0555 /app/container-entrypoint.sh && groupadd --system --gid 10001 mcp && useradd --system --uid 10001 --gid mcp --home-dir /app --no-create-home mcp && mkdir -p /app/data && chown -R mcp:mcp /app
USER mcp
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "/app/healthcheck.mjs"]
ENTRYPOINT ["/app/container-entrypoint.sh"]
