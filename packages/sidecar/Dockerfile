# Sidecar: enterprise connector — receives decrypted data, routes to storage
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js db.js auth.js config.js crypto.js ./
COPY lib/ lib/
COPY connectors/ connectors/

ENV PORT=3090
EXPOSE 3090

CMD ["node", "server.js"]
