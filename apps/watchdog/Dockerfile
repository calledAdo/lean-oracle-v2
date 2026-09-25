# Lean Oracle watchdog image. Build from the repository root:
#   docker build -f apps/watchdog/Dockerfile -t lean-oracle-watchdog .
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/watchdog/package.json apps/watchdog/
RUN npm ci --workspace lean-oracle-watchdog
COPY apps/watchdog apps/watchdog
RUN npm run build -w lean-oracle-watchdog

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/watchdog/package.json apps/watchdog/package.json
COPY --from=build /repo/apps/watchdog/dist apps/watchdog/dist
USER node
ENTRYPOINT ["node", "apps/watchdog/dist/main.js"]
