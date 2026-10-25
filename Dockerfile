# syntax=docker/dockerfile:1
#
# The NAS image: one static binary with the web bundle inside it, nothing else.
#
#   docker build -t spm-server:dev .
#   docker run --rm -p 8000:8000 -v /path/to/library:/library spm-server:dev

# ---- 1. the web bundle -------------------------------------------------------------------------
FROM node:24-alpine AS web
# The pnpm version comes from the `packageManager` field in package.json.
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile --filter @spm/web...
COPY packages/web packages/web
RUN pnpm --filter @spm/web build

# ---- 2. the server, static, for x86_64 musl --------------------------------------------------
FROM rust:1.99.1-alpine AS build
# musl-dev and a C compiler: SQLite is bundled and compiled from source.
RUN apk add --no-cache musl-dev build-base
WORKDIR /src
# The toolchain is the image's own; rust-toolchain.toml is deliberately not copied (it would make
# cargo download the same version again).
COPY Cargo.toml Cargo.lock ./
COPY crates crates
# A workspace member, so cargo must be able to read it; it is not built for the server.
COPY apps/desktop/src-tauri apps/desktop/src-tauri
# build.rs embeds this directory.
COPY --from=web /src/packages/web/dist packages/web/dist
RUN rustup target add x86_64-unknown-linux-musl \
 && cargo build --release --locked --target x86_64-unknown-linux-musl -p spm-server
# The runtime image has no shell to make these with.
RUN mkdir -p /rootfs/library /rootfs/tmp \
 && chmod 1777 /rootfs/tmp \
 && cp target/x86_64-unknown-linux-musl/release/spm-server /rootfs/spm-server

# ---- 3. the runtime ------------------------------------------------------------------------------
FROM scratch
COPY --from=build /rootfs/spm-server /spm-server
# The library volume belongs to the unprivileged user; /tmp is SQLite's scratch space.
COPY --from=build --chown=10001:10001 /rootfs/library /library
COPY --from=build --chmod=1777 /rootfs/tmp /tmp
USER 10001:10001
ENV SPM_LIBRARY_DIR=/library \
    SPM_PORT=8000
VOLUME /library
EXPOSE 8000
ENTRYPOINT ["/spm-server"]
