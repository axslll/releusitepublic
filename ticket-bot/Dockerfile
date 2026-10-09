# Builds the Discord bot on Railway (or any Docker host).
# Works whether the build context is the repo root (bot in ./ticket-bot) or ./ticket-bot itself.
FROM node:22-slim
WORKDIR /app

COPY . /tmp/src
RUN if [ -f /tmp/src/ticket-bot/package.json ]; then cp -a /tmp/src/ticket-bot/. /app/; else cp -a /tmp/src/. /app/; fi \
 && rm -rf /tmp/src

# --ignore-scripts: onnxruntime-node already ships its CPU binaries; its install script only fetches optional GPU files.
RUN npm ci --ignore-scripts --no-audit --no-fund

# Bake the moderation model into the image so restarts don't have to download it. Never fails the build.
RUN node --no-warnings -e "import('@huggingface/transformers').then(m => m.pipeline('text-classification', 'Xenova/toxic-bert')).then(() => console.log('moderation model cached'))" \
 || echo "model not cached at build time - it will download on first start instead"

ENV NODE_ENV=production
# Tickets and the moderation on/off switch are saved in /app/data - mount a Railway volume there to keep them across deploys.
CMD ["node", "src/index.js"]
