FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run relay:build

FROM node:24-alpine
WORKDIR /app
COPY --from=builder --chown=node:node /app/build-relay/workspace-relay.mjs ./workspace-relay.mjs
USER node
ENV SAKURA_RELAY_HOST=0.0.0.0 SAKURA_RELAY_PORT=8787
EXPOSE 8787
CMD ["node", "workspace-relay.mjs"]
