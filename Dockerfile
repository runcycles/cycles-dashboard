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

# Serve stage — Alpine 3.23 ships patched openssl/libxml2/libpng/musl/zlib
# closing the 57 HIGH/CRITICAL CVEs Trivy flagged against Alpine 3.21.3.
FROM nginx:1.29-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
