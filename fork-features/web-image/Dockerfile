# syntax=docker/dockerfile:1
#
# Split-deployment web role: the browser bundle compiled in self-hosted mode,
# served by nginx together with the same-origin daemon proxy. The daemon role is
# docker/base/Dockerfile. Build from the repository root:
#   docker build -f fork-features/web-image/Dockerfile .

ARG NODE_IMAGE=node:22-bookworm-slim
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web-build

ARG PASEO_VERSION

ENV ONNXRUNTIME_NODE_INSTALL=skip \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /tmp/paseo-src
COPY . .

RUN set -eux; \
    if [ -n "${PASEO_VERSION:-}" ]; then \
      test "$(node -p "require('./package.json').version")" = "${PASEO_VERSION}"; \
    fi; \
    node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); delete pkg.scripts.prepare; fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci

# Expo inlines EXPO_PUBLIC_* at export time; the bundle cannot switch modes later.
RUN set -eux; \
    EXPO_PUBLIC_PASEO_SELFHOSTED=true npm run build:web --workspace=@getpaseo/app; \
    test -f packages/app/dist/index.html

FROM ${NODE_IMAGE}

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends nginx ca-certificates; \
    rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/default; \
    mkdir -p /usr/share/nginx/html /usr/local/lib/paseo /etc/paseo; \
    ln -sf /dev/stdout /var/log/nginx/access.log; \
    ln -sf /dev/stderr /var/log/nginx/error.log

COPY --from=web-build /tmp/paseo-src/packages/app/dist /usr/share/nginx/html
COPY fork-features/web-image/generate-config.mjs /usr/local/lib/paseo/generate-config.mjs
COPY fork-features/web-image/paseo-web-entrypoint.sh /usr/local/bin/paseo-web-entrypoint
RUN chmod +x /usr/local/bin/paseo-web-entrypoint

EXPOSE 6767

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:6767/_paseo/hosts.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/paseo-web-entrypoint"]
