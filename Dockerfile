# syntax=docker/dockerfile:1
FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/melo-api ./server

# yt-dlp is intentionally server-only. Pin it to the same release used by the
# desktop dependency manager; no provider executable or credential reaches JS.
FROM python:3.13-slim-bookworm
ARG YTDLP_VERSION=2026.08.19
RUN pip install --no-cache-dir "yt-dlp==${YTDLP_VERSION}" \
    && useradd --create-home --uid 10001 melo \
    && mkdir -p /data \
    && chown melo:melo /data
COPY --from=build /out/melo-api /usr/local/bin/melo-api
USER melo
ENV ADDR=:8080 \
    MELO_ENV=production \
    MELO_DATA_DIR=/data \
    MELO_YTDLP=/usr/local/bin/yt-dlp \
    COOKIE_SECURE=true
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/melo-api"]
