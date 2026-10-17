# Build stage: compiles src/ to dist/ with the dev dependencies (TypeScript).
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime stage: only the compiled code and the production dependencies.
FROM node:22-alpine

WORKDIR /app

# Turns off GraphQL introspection and the Sandbox landing page (see src/app.ts).
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 8080

CMD ["node", "dist/index.js"]
