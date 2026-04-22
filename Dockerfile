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

# Serve stage — Alpine 3.23 base plus `apk upgrade` so each build pulls in
# the latest alpine security patches. Without the upgrade step Trivy fails
# any day a new HIGH/CRITICAL CVE is disclosed against the pinned minor
# before upstream refloats the nginx:1.29-alpine tag.
FROM nginx:1.29-alpine
RUN apk update && apk upgrade --no-cache && rm -rf /var/cache/apk/*
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
