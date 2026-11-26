# Cursor Run（サーバーつきの版）。記録は /data に保存するので、そこに消えない置き場（ボリューム）を付ける。
#   docker build -t cursor-run . && docker run -p 8080:8080 -v cursorrun-data:/data -e ADMIN_TOKEN=<合言葉> cursor-run
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
COPY server.js verify.js harness.js index.html og.png ./
# TRUST_PROXY=1: 前段に 1 つプロキシ（PaaS の入口や Cloudflare）がある前提。直接つながせるなら 0 にする
ENV PORT=8080 DATA_DIR=/data TRUST_PROXY=1 NODE_ENV=production
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.js"]
