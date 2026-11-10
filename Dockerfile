FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY web ./web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]
