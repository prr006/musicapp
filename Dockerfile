# syntax=docker/dockerfile:1
#
# Static web deployment for MELO.
#
# The web build is a pure static site: data comes from the in-browser fixture
# catalogue and playback happens client-side through the official YouTube
# IFrame player. There is deliberately NO API server in this image — no
# /resolve, no /stream, no media proxy, no yt-dlp.
#
# Railway (and any Docker host) builds this image and nginx serves the bundle
# on $PORT.
FROM node:20-alpine AS build
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM nginx:1.27-alpine
ENV PORT=8080
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 8080
