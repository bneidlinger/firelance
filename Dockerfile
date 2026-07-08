# Firelance — single-container deploy: one Node process serves the built
# client AND the authoritative WebSocket sim on one port (same-origin wss).
#
#   docker build -t firelance .
#   docker run -p 8787:8787 firelance
#
# Tune the match via CMD flags below (--config prototype|default, --bots N).

# ---- build stage: workspace install + client build + single-file server bundle
FROM node:22-slim AS build
WORKDIR /app
# Manifests first so `npm ci` layer-caches across code-only changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/bots/package.json packages/bots/
COPY packages/client/package.json packages/client/
RUN npm ci
COPY tsconfig.base.json ./
COPY scripts/build-server.mjs scripts/
COPY packages ./packages
RUN npm run build

# ---- runtime stage: node + two artifacts, no node_modules at all
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist/server.mjs ./server.mjs
COPY --from=build /app/packages/client/dist ./client
EXPOSE 8787
# PORT env (fly.io etc.) overrides 8787 automatically; flags override both.
CMD ["node", "server.mjs", "--config", "prototype", "--bots", "11", "--static", "./client"]
