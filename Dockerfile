ARG NODE_IMAGE=node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

FROM ${NODE_IMAGE} AS build
# Node2Shell (CVE-2026-111497) is fixed in Node 26.12.1; keep this floor when bumping NODE_IMAGE.
RUN node -e 'const [a, b, c] = process.versions.node.split(".").map(Number); if (a < 26 || (a === 26 && (b < 12 || (b === 12 && c < 1)))) { console.error("Node >= 26.12.1 required"); process.exit(1); }'
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY LICENSE tsconfig.server.json tsconfig.web.json ./
COPY server/ ./server/
COPY web/ ./web/
RUN npm run build:app && npm prune --omit=dev

FROM ${NODE_IMAGE}
RUN node -e 'const [a, b, c] = process.versions.node.split(".").map(Number); if (a < 26 || (a === 26 && (b < 12 || (b === 12 && c < 1)))) process.exit(1)' \
  && mkdir -p /data && chown node:node /data
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATABASE_PATH=/data/pokerbot.sqlite
COPY --from=build /app/package.json ./
COPY LICENSE docs/third-party-notices.md ./
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
USER node
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
