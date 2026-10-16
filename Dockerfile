FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps

COPY src ./src

EXPOSE 8080

CMD ["node", "src/index.js"]
