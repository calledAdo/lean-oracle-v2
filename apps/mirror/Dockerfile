# Lean Oracle mirror image. Build from the repository root:
#   docker build -f apps/mirror/Dockerfile -t lean-oracle-mirror .
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/mirror/package.json apps/mirror/
RUN npm ci --workspace lean-oracle-sdk --workspace lean-oracle-mirror
COPY packages/sdk packages/sdk
COPY apps/mirror apps/mirror
RUN npm run build -w lean-oracle-sdk && npm run build -w lean-oracle-mirror

FROM node:24-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/mirror/package.json apps/mirror/
RUN npm ci --omit=dev --workspace lean-oracle-sdk --workspace lean-oracle-mirror

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /repo/node_modules node_modules
COPY --from=build /repo/packages/sdk/package.json packages/sdk/package.json
COPY --from=build /repo/packages/sdk/dist packages/sdk/dist
COPY --from=build /repo/apps/mirror/package.json apps/mirror/package.json
COPY --from=build /repo/apps/mirror/dist apps/mirror/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7800
ENTRYPOINT ["node", "apps/mirror/dist/main.js"]
CMD ["run", "--config", "/config/mirror.json"]
