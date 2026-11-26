# Cursor Run（サーバーつきの版）。記録は /data に保存するので、そこに消えない置き場（ボリューム）を付ける。
#   docker build -t cursor-run . && docker run -p 8080:8080 -v cursorrun-data:/data -e ADMIN_TOKEN=<合言葉> cursor-run
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
COPY server.js verify.js harness.js index.html og.png ./
# TRUST_PROXY はここでは決めない。置く場所に合わせて実行時に渡す（PaaS の入口が 1 つなら -e TRUST_PROXY=1、Cloudflare の後ろなら cf）。
# 外から直接つながる構成で設定すると、相手が接続元を偽って回数の上限をすり抜けられる
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.js"]
