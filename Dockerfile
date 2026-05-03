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
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
