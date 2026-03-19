# Minimal CORS proxy for SHL manifest fetches (encrypted traffic only)
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js ssrf.js ./
COPY lib/ lib/

ENV PORT=3080
EXPOSE 3080

CMD ["node", "server.js"]
