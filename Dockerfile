# Synaipse all-in-one image — serves the Web API (port 3001) + the built
# vanilla-TS frontend + the MCP HTTP transport (mounted under /mcp on the
# same port). One container, not three.
#
# Build:
#   docker build -t synaipse:dev .
#
# Run standalone (requires a reachable MariaDB when SYNAIPSE_MODE=server):
#   docker run --rm -p 3001:3001 --env-file .env synaipse:dev
#
# Compose-friendly: see the `synaipse-web` service under `--profile server`.

# --- Stage 1: build ---------------------------------------------------------
FROM node:22-slim AS builder

WORKDIR /app

# Install deps with the lockfile so the build is reproducible. Workspace
# layout: copy the manifests first so a code-only change doesn't bust the
# npm cache layer.
COPY package.json package-lock.json ./
COPY packages/core/package.json            packages/core/
COPY packages/vault/package.json           packages/vault/
COPY packages/vector/package.json          packages/vector/
COPY packages/service/package.json         packages/service/
COPY packages/server-storage/package.json  packages/server-storage/
COPY packages/mcp-server/package.json      packages/mcp-server/
COPY packages/web/package.json             packages/web/
COPY packages/crawler/package.json         packages/crawler/

# Full install for the builder — rollup's platform-specific native binary
# (@rollup/rollup-linux-x64-gnu) is in optionalDependencies, and `vite build`
# crashes without it (npm/cli#4828). The runtime stage below trims with
# --omit=optional so the final image stays lean.
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages

RUN npm run build && \
    cd packages/web && npx vite build

# --- Stage 2: runtime -------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV SYNAIPSE_STATIC_DIR=/app/packages/web/dist/web

WORKDIR /app

# Re-install with --omit=dev so dev tooling (vitest, tsc, vite, eslint) is
# not in the final image. Build output is copied from the builder stage.
COPY package.json package-lock.json ./
COPY packages/core/package.json            packages/core/
COPY packages/vault/package.json           packages/vault/
COPY packages/vector/package.json          packages/vector/
COPY packages/service/package.json         packages/service/
COPY packages/server-storage/package.json  packages/server-storage/
COPY packages/mcp-server/package.json      packages/mcp-server/
COPY packages/web/package.json             packages/web/
COPY packages/crawler/package.json         packages/crawler/

RUN npm ci --omit=dev --omit=optional

# Compiled JS + the SQL migrations (server-storage reads them at boot).
COPY --from=builder /app/packages/core/dist             packages/core/dist
COPY --from=builder /app/packages/vault/dist            packages/vault/dist
COPY --from=builder /app/packages/vector/dist           packages/vector/dist
COPY --from=builder /app/packages/service/dist          packages/service/dist
COPY --from=builder /app/packages/server-storage/dist   packages/server-storage/dist
COPY --from=builder /app/packages/server-storage/migrations  packages/server-storage/migrations
COPY --from=builder /app/packages/mcp-server/dist       packages/mcp-server/dist
COPY --from=builder /app/packages/web/dist              packages/web/dist
COPY --from=builder /app/packages/crawler/dist          packages/crawler/dist

EXPOSE 3001

# Default = web (API + static + MCP under /mcp). Override `command:` in
# compose for the user CLI or any other workspace script.
CMD ["node", "--enable-source-maps", "packages/web/dist/server/index.js"]