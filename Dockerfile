# Build stage
# Base image pinned to minor version to prevent silent supply-chain drift
# between builds. Bump deliberately when upgrading Node / Alpine.
# Node >=20.19 is required by vite 8 / rolldown (engines field).
FROM node:20.20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Serve stage — pinned to Alpine 3.23 explicitly because nginx:1.29-alpine
# (unpinned) was tracking an older Alpine where xz-libs and nghttp2-libs
# fixes hadn't propagated. Alpine 3.23 has nghttp2 1.69.0-r0 and xz 5.8.3-r0,
# both newer than the CVE-fix versions Trivy was waiting for.
#
# `apk upgrade` is still here so each build pulls in any subsequent Alpine
# 3.23 patches without needing a Dockerfile bump.
FROM nginx:1.29-alpine3.23
RUN apk update && apk upgrade --no-cache && rm -rf /var/cache/apk/*
COPY --from=build /app/dist /usr/share/nginx/html
# Ship the reverse-proxy config as an envsubst template. The stock nginx
# entrypoint (20-envsubst-on-templates.sh) renders every
# /etc/nginx/templates/*.template into /etc/nginx/conf.d/ at container
# start, substituting only the env vars that are actually set — so the
# ADMIN_UPSTREAM / RUNTIME_UPSTREAM placeholders below are filled while
# nginx's own $host / $request_uri / $upstream variables are preserved.
COPY default.conf.template /etc/nginx/templates/default.conf.template
# Default upstreams match the bundled docker-compose service names, so the
# image works out of the box. Override either var at deploy time to point
# the bundled proxy at different admin / runtime hosts without rebuilding.
ENV ADMIN_UPSTREAM=http://cycles-admin:7979 \
    RUNTIME_UPSTREAM=http://cycles-server:7878
EXPOSE 80
# Liveness: nginx serves the SPA shell. Drives the compose/orchestrator
# healthcheck so a crashed nginx is detected and restarted.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --spider -q http://127.0.0.1/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
