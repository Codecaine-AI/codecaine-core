# Development packages change rapidly and have no releases yet. This image pins
# only the runtime; Compose mounts the current working tree and installs there.
FROM oven/bun:1.3.10

# Named-volume mountpoints must exist bun-owned in the image so overlay volumes are writable by the non-root user.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        git \
        make \
        ca-certificates \
        python3 \
        build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && if ! id -u bun >/dev/null 2>&1; then useradd --create-home --shell /bin/sh bun; fi \
    && mkdir -p /bun-cache \
    && mkdir -p /workspace/node_modules /workspace/observatory/node_modules \
    && chown -R bun:bun /bun-cache /workspace

WORKDIR /workspace
ENV BUN_INSTALL_CACHE_DIR=/bun-cache

USER bun

# Install only at the mounted Core root: workspace:* dependencies cannot be
# resolved by per-member installs. Then replace the shell with the service.
ENTRYPOINT ["/bin/sh", "-c", "bun install && exec \"$@\"", "--"]
