# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Install deps
COPY services/api/package.json ./
# No lockfile yet; use npm install
RUN npm install --omit=dev

# Copy app (all sources)
COPY services/api/ ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]

