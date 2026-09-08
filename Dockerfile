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
RUN apt-get update \
    && apt-get install --yes --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir "yt-dlp==${YTDLP_VERSION}" \
    && useradd --create-home --uid 10001 melo \
    && mkdir -p /data \
    && chown melo:melo /data
COPY --from=build /out/melo-api /usr/local/bin/melo-api
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh
ENV ADDR=:8080 \
    MELO_ENV=production \
    MELO_DATA_DIR=/data \
    MELO_YTDLP=/usr/local/bin/yt-dlp \
    COOKIE_SECURE=true
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/usr/local/bin/melo-api"]
