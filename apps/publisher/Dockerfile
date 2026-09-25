# Lean Oracle publisher image. Build from the repository root:
#   docker build -f apps/publisher/Dockerfile -t lean-oracle-publisher .
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/publisher/package.json apps/publisher/
RUN npm ci --workspace lean-oracle-sdk --workspace lean-oracle-publisher
COPY packages/sdk packages/sdk
COPY apps/publisher apps/publisher
RUN npm run build -w lean-oracle-sdk && npm run build -w lean-oracle-publisher

FROM node:24-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/publisher/package.json apps/publisher/
RUN npm ci --omit=dev --workspace lean-oracle-sdk --workspace lean-oracle-publisher

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /repo/node_modules node_modules
COPY --from=build /repo/packages/sdk/package.json packages/sdk/package.json
COPY --from=build /repo/packages/sdk/dist packages/sdk/dist
COPY --from=build /repo/apps/publisher/package.json apps/publisher/package.json
COPY --from=build /repo/apps/publisher/dist apps/publisher/dist
COPY --from=build /repo/apps/publisher/configs apps/publisher/configs
COPY --from=build /repo/apps/publisher/scripts apps/publisher/scripts
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7700 7701
ENTRYPOINT ["node", "apps/publisher/dist/main.js"]
CMD ["run", "--config", "/config/publisher.json"]
