# Client-only SHL scanner — static files served by nginx.
# Build the scanner first: npm run build -w @ktc/scanner (produces dist/core/).
FROM nginx:alpine

# Remove default content and copy our static build
RUN rm -rf /usr/share/nginx/html/*

COPY dist/core/ /usr/share/nginx/html/

# Optional: custom nginx config to set correct MIME types and cache headers
# COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
