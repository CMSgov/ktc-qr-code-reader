# Client-only SHL scanner — multi-stage build, static files served by nginx.

# Stage 1: build the static artifact
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json ./
COPY data/ data/
COPY src/ src/
COPY scripts/ scripts/
COPY public/ public/

RUN npm run build

# Stage 2: serve with nginx
FROM nginx:alpine

RUN rm -rf /usr/share/nginx/html/*

COPY --from=build /app/dist/core/ /usr/share/nginx/html/

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
