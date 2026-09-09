# Multi-stage: build with dev deps, ship a slim runtime with prod deps + dist.
# The migration entrypoint (`node dist/database/migrate.js`) works without tsx
# because tsc compiles it and the build step copies the .sql files into dist.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
