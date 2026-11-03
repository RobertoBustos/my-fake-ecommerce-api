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

# Through NODE_OPTIONS so the Cloud Run jobs, which run
# `node dist/jobs/<job>.js` from this same image, get both flags too:
# - --conditions=dist points the #src/* imports at the compiled dist/
#   instead of src/ (see "imports" in package.json);
# - --import starts tracing before the app or a job loads anything (see
#   src/telemetry.ts). It does nothing unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
ENV NODE_OPTIONS="--conditions=dist --import=/app/dist/telemetry.js"

EXPOSE 8080

CMD ["node", "dist/index.js"]
