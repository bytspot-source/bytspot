# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app

# Copy the real Bytspot frontend from loc-byt
COPY loc-byt/package.json loc-byt/package-lock.json* ./

# Install dependencies
RUN npm ci || npm i

# Copy source code and build configuration
COPY loc-byt/src ./src
COPY loc-byt/index.html ./
COPY loc-byt/vite.config.ts ./
COPY loc-byt/packages ./packages

# Build the React app
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy built assets to nginx
COPY --from=builder /app/build /usr/share/nginx/html

# Copy nginx configuration for SPA routing
RUN echo 'server { \
    listen 8080; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html index.htm; \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]

