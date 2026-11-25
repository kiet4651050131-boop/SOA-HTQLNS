FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production PORT=3000 CORE_PORT=3100 CORE_HOST=127.0.0.1 CORE_SERVICE_URL=http://127.0.0.1:3100 EMAIL_PORT=3200 EMAIL_HOST=127.0.0.1 EMAIL_SERVICE_URL=http://127.0.0.1:3200 TZ=Asia/Ho_Chi_Minh
VOLUME /app/data
EXPOSE 3000
CMD ["node", "dist/launcher.js"]
