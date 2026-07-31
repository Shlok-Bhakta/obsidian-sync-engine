FROM docker.io/library/node:24-alpine AS plugin-build

WORKDIR /app

COPY shared/protocol/package.json shared/protocol/package-lock.json ./shared/protocol/
RUN --mount=type=cache,target=/root/.npm npm ci --prefix shared/protocol

COPY plugin/package.json plugin/package-lock.json ./plugin/
RUN --mount=type=cache,target=/root/.npm npm ci --prefix plugin

COPY shared/protocol ./shared/protocol
COPY plugin ./plugin
RUN npm run build --prefix plugin

FROM docker.io/oven/bun:1-alpine AS server-dependencies

WORKDIR /app

COPY shared/protocol ./shared/protocol
COPY server/package.json server/bun.lock ./server/
RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --cwd server --frozen-lockfile --production

COPY server/src ./server/src

FROM docker.io/oven/bun:1-alpine AS runtime

WORKDIR /app/server

ENV NODE_ENV=production \
	PORT=3000 \
	HOST=0.0.0.0 \
	PLUGIN_DIST_DIR=/app/plugin

LABEL org.opencontainers.image.source="https://github.com/Shlok-Bhakta/obsidian-sync-engine"

COPY --from=server-dependencies --chown=bun:bun /app/server /app/server
COPY --from=server-dependencies --chown=bun:bun /app/shared/protocol /app/shared/protocol
COPY --from=plugin-build --chown=bun:bun /app/plugin/obsidian-sync-engine/ /app/plugin/

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["bun", "-e", "const response = await fetch('http://127.0.0.1:3000/health'); if (!response.ok) process.exit(1)"]

ENTRYPOINT ["bun", "run", "src/index.ts"]
