FROM node:22-alpine AS deps
WORKDIR /app
COPY backend/package.json ./
RUN npm install --no-audit --no-fund

FROM deps AS dev
COPY backend/tsconfig.json backend/tsconfig.build.json backend/vitest.config.ts ./
COPY backend/src ./src
COPY backend/tests ./tests
COPY database/migrations ./migrations
CMD ["npm", "test"]

FROM dev AS build
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY database/migrations ./migrations
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
