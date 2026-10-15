FROM node:24.19.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node runtime ./runtime
COPY --chown=node:node config ./config
COPY --chown=node:node skills ./skills
COPY --chown=node:node examples ./examples
COPY --chown=node:node test-support ./test-support
COPY --chown=node:node openapi.json ./openapi.json
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HARNESS_DATA_DIR=/app/data
CMD ["node", "src/server.mjs"]
