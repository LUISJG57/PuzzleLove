# PuzzleLove production image (monorepo: shared + server + client + tools/simulator).
# Targets:
#   runtime  -> the app (default)
#   migrate  -> one-shot `prisma migrate deploy`
FROM node:24-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------------------------------------------------------------- dependencies
FROM base AS deps
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY tools/simulator/package.json tools/simulator/
# Install scripts are skipped (npm 11 blocks them anyway); Prisma is generated explicitly below.
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY client client
COPY tools/simulator tools/simulator
RUN npm run build

# ---------------------------------------------------------------- migrations
FROM build AS migrate
WORKDIR /app/server
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ---------------------------------------------------------------- production deps
FROM build AS prod-deps
RUN npm prune --omit=dev --ignore-scripts

# ---------------------------------------------------------------- runtime
FROM base AS runtime
# sharp renders the default global image's SVG text; without fonts the title comes out blank.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3001
COPY --from=prod-deps --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/package.json package.json
COPY --from=build --chown=node:node /app/server/package.json server/package.json
COPY --from=build --chown=node:node /app/server/dist server/dist
COPY --from=build --chown=node:node /app/client/dist client/dist
# Live bots (docker-compose `bots` service) run from the same image.
COPY --from=build --chown=node:node /app/tools/simulator/package.json tools/simulator/package.json
COPY --from=build --chown=node:node /app/tools/simulator/dist tools/simulator/dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/dist/index.js"]
