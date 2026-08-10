# 24/7 always-on runner for capitaltinking.
# Runs `npm run loop`: one decide-and-trade cycle every LOOP_INTERVAL_MINUTES.
FROM node:22-slim
WORKDIR /app

# Install deps first for layer caching (tsx/typescript are needed to run).
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Persist the trade ledger on a mounted volume so it survives restarts.
ENV LEDGER_DIR=/data
VOLUME ["/data"]

# All other config comes from environment variables (see .env.example).
# Provide them as host secrets — never bake keys into the image.
CMD ["npm", "run", "loop"]
