# syntax=docker/dockerfile:1
FROM node:20-alpine
WORKDIR /app
COPY services/gateway-bff/package.json services/gateway-bff/package-lock.json* ./
RUN npm ci || npm i
COPY services/gateway-bff .
EXPOSE 3000
CMD ["node", "server.js"]

