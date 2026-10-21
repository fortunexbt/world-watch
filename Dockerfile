FROM node:24.18.0-bookworm-slim AS application
RUN groupadd --gid 10001 ew && useradd --uid 10001 --gid ew --create-home ew
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY public ./public
COPY deploy/migrations ./deploy/migrations
COPY deploy/remote-worker-entrypoint.mjs ./deploy/remote-worker-entrypoint.mjs
COPY wrangler.jsonc vite.config.ts tsconfig.json index.html ./
RUN npm run build && mkdir -p /data/wrangler /data/worker /home/ew/.codex && chown -R ew:ew /app /data /home/ew
ENV HOME=/home/ew NODE_ENV=production CI=true WRANGLER_SEND_METRICS=false
USER ew
EXPOSE 8787
ENTRYPOINT ["node", "deploy/remote-worker-entrypoint.mjs"]
CMD ["backend"]

FROM application AS analysis
USER root
ARG CODEX_VERSION=0.160.1
RUN npm install --global @openai/codex@${CODEX_VERSION}
USER ew
ENV EW_CODEX_BIN=/usr/local/bin/codex EW_WORKER_STATE=/data/worker
CMD ["analysis"]
