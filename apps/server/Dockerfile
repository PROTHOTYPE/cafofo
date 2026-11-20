# syntax=docker/dockerfile:1

FROM rust:slim-bookworm AS builder

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Copia manifests do workspace + lockfile + crates necessários para resolver o workspace Cargo
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps/server ./apps/server

# Compila exclusivamente o binário do servidor de sinalização Axum em release
RUN cargo build --release --locked -p cafofo-server

# Runtime mínimo Debian Bookworm com ca-certificates + ffmpeg + deno + yt-dlp (Bot de Música)
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 unzip \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /usr/local/bin \
    && chmod a+rx /usr/local/bin/deno \
    && rm -f /tmp/deno.zip \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --uid 10001 cafofo

COPY --from=builder /app/target/release/cafofo-server /usr/local/bin/cafofo-server

ENV CAFOFO_HOST=0.0.0.0
ENV CAFOFO_PORT=3001
ENV RUST_LOG=cafofo_server=info,tower_http=info

USER cafofo
EXPOSE 3001

ENTRYPOINT ["/usr/local/bin/cafofo-server"]
