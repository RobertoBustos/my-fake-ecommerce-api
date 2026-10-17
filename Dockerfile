FROM node:22-alpine

WORKDIR /app

# Turns off GraphQL introspection and the Sandbox landing page (see src/app.js).
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 8080

CMD ["node", "src/index.js"]
