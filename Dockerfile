# Single-process deployment: one Node server serves the API, the collab
# WebSocket, and the built editor bundle.
FROM node:22-bookworm-slim

WORKDIR /app

# Workspace manifests first so the dependency layer caches across code changes.
# NODE_ENV is deliberately unset here: the build needs vite, and the server runs
# through tsx, both of which are devDependencies.
COPY package.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production \
    COLLAB_EMBEDDED_WS=1 \
    PROOF_TRUST_PROXY_HEADERS=1

# SQLite lives on a mounted volume; set DATABASE_PATH to a file on it.
CMD ["npx", "tsx", "server/index.ts"]
