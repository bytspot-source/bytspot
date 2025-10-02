# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

# Copy package files from the real gateway-bff location
COPY loc-byt/services/gateway-bff/package.json loc-byt/services/gateway-bff/package-lock.json* ./

# Install dependencies
RUN npm ci || npm i

# Copy the gateway-bff source code
COPY loc-byt/services/gateway-bff .

# Copy OpenAPI specs needed by the BFF
COPY loc-byt/apis /apis

EXPOSE 8080
CMD ["node", "server.js"]
