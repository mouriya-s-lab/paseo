# Running the Paseo fork in Docker

The fork publishes one artifact: a Docker image containing the Paseo daemon and
its bundled browser UI. The image runs on a server, VM, NAS, or homelab host.
The image source lives in [`docker/`](../docker/).

## How it works

The image:

- builds the daemon and CLI from source-built workspace tarballs;
- runs the daemon as the non-root `paseo` user;
- listens on `0.0.0.0:6767` inside the container;
- serves the bundled web UI with `PASEO_WEB_UI_ENABLED=true`;
- stores daemon state and agent credentials under `/home/paseo`;
- leaves agent CLIs out of the base image.

Open the container's HTTP origin, for example `http://localhost:6767`, to load
the web UI. The Docker build sets `EXPO_PUBLIC_LOCAL_DAEMON=self-hosted`, so
the browser can use the page host as its direct TCP endpoint. API and WebSocket
requests still require `PASEO_PASSWORD` when one is configured.

## Quick start

```bash
docker run -d --name paseo \
  -p 6767:6767 \
  -e PASEO_PASSWORD=change-me \
  -v "$PWD/paseo-home:/home/paseo" \
  -v "$PWD:/workspace" \
  ghcr.io/mouriya-s-lab/paseo:latest
```

Then open:

```text
http://localhost:6767
```

If you set `PASEO_PASSWORD`, enter the same password when adding the direct
daemon connection in the web UI or another Paseo client.

## Docker Compose

Use [`docker/docker-compose.example.yml`](../docker/docker-compose.example.yml):

```bash
cp docker/docker-compose.example.yml docker-compose.yml
$EDITOR docker-compose.yml
docker compose up -d
```

Minimal example:

```yaml
services:
  paseo:
    image: ghcr.io/mouriya-s-lab/paseo:latest
    restart: unless-stopped
    ports:
      - "6767:6767"
    environment:
      PASEO_PASSWORD: "change-me"
    volumes:
      - ./paseo-home:/home/paseo
      - ./workspace:/workspace
```

## Installing Agents

The base image does not preinstall Claude Code, Codex, OpenCode, Copilot, Pi, or
other agent CLIs. Create a child image for the agents you use:

```Dockerfile
FROM ghcr.io/mouriya-s-lab/paseo:latest

USER root
RUN npm install -g @openai/codex @anthropic-ai/claude-code opencode-ai
```

Build it:

```bash
docker build -f Dockerfile -t paseo-with-agents .
```

Then use `image: paseo-with-agents` in Compose. Leave the child image user as
root. The base entrypoint uses root only for first-run directory setup, then
drops the daemon and launched agents to the non-root `paseo` user.

An example child image is in
[`docker/Dockerfile.agents.example`](../docker/Dockerfile.agents.example).

Agent credentials and config persist in `/home/paseo`, alongside daemon state.
Provider environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_BASE_URL`, or `ANTHROPIC_BASE_URL` can be passed through `docker run -e`
or `compose.environment`; Paseo passes them to launched agents.

## Volumes

| Mount         | Purpose                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `/home/paseo` | Paseo state under `.paseo` plus agent config such as `.codex` and `.claude` |
| `/workspace`  | Code that Paseo and launched agents can read and write                      |

The image defaults:

| Variable       | Default              |
| -------------- | -------------------- |
| `HOME`         | `/home/paseo`        |
| `PASEO_HOME`   | `/home/paseo/.paseo` |
| `PASEO_LISTEN` | `0.0.0.0:6767`       |

If you bind-mount host directories on Linux, make sure the container user can
write them. The built-in `paseo` user has uid/gid `1000:1000`. For a different
host uid/gid, adjust ownership or set Docker's `--user` / Compose `user:` option.

## Same-origin multi-daemon mode

The fork code also supports a public App origin that proxies several daemons.
That mode requires a deployment layer to serve `/_paseo/hosts.json` and route
each `/daemons/<id>/` path to a daemon. The manifest entries are strict objects:

```json
[{ "id": "alpha", "label": "Alpha", "basePath": "/daemons/alpha" }]
```

Build the browser bundle with `EXPO_PUBLIC_PASEO_SELFHOSTED=true` only when that
manifest and proxy are present. The standard daemon image above keeps this flag
false and connects to its own daemon. The connection and persistence code lives
in [`packages/app/src/fork-features/self-hosted/`](../packages/app/src/fork-features/self-hosted/).

## Reverse Proxies

When serving the standard daemon image behind a reverse proxy, forward normal
HTTP requests and WebSocket upgrades to port 6767.

Caddy example:

```caddy
paseo.example.com {
  reverse_proxy 127.0.0.1:6767
}
```

Nginx example:

```nginx
server {
    listen 443 ssl;
    server_name paseo.example.com;

    location / {
        proxy_pass http://127.0.0.1:6767;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

If you reach the daemon by DNS name, set `PASEO_HOSTNAMES` so host-header
validation allows that name:

```yaml
environment:
  PASEO_HOSTNAMES: "paseo.example.com,.lan"
```

IPs and `localhost` are allowed by default.

## Security

- Set `PASEO_PASSWORD` for any published port or network-reachable deployment.
- Prefer HTTPS at the reverse proxy for direct browser access.
- Use the [official Paseo relay](https://github.com/getpaseo/paseo-relay) for
  untrusted networks or mobile access when you do not want to expose the daemon
  port directly.
- The container is the isolation boundary for agents. Agents can read and write
  whatever you mount into `/workspace` and whatever credentials you place in
  `/home/paseo`.
- Bundled web UI static files are public on the daemon origin. The daemon API and
  WebSocket remain protected by password auth when configured.

See [SECURITY.md](../SECURITY.md) for the daemon trust model.

## Building locally

```bash
docker build -f docker/base/Dockerfile -t paseo:local .
```

To assert the source tree version while building:

```bash
docker build \
  --build-arg PASEO_VERSION=0.7.2 \
  --build-arg EXPO_PUBLIC_PASEO_SELFHOSTED=false \
  --build-arg EXPO_PUBLIC_LOCAL_DAEMON=self-hosted \
  -t paseo:0.7.2 \
  -f docker/base/Dockerfile \
  .
```

## Fork release workflow

The fork's only GitHub Actions build is
[`.github/workflows/docker.yml`](../.github/workflows/docker.yml). It runs on
the self-hosted GARM labels `self-hosted`, `linux`, `vctcn`, `netbird`, and
`x64`.

- Same-repository pull requests build a native `linux/amd64` image without pushing.
- Every `main` push and the hourly schedule resolve the highest reachable upstream release tag.
- A manual dispatch on `main` runs the same release path.
- A stable upstream base `vX.Y.Z` becomes fork tag `vX.Y.Z-fork.N` and image tag `X.Y.Z-fork.N`; `latest` points to that image too.
- An upstream prerelease `vX.Y.Z-<id>` becomes `vX.Y.Z-<id>-fork.N` and does not update `latest`.
- `N` starts at `0`, increments from the highest existing suffix for that upstream base, and is reused when the same commit is retried.
- The image is built and pushed before the fork tag is created.

The resolver can be inspected locally:

```bash
node scripts/fork-release-version.mjs --ref HEAD
```

The fork does not publish npm, Desktop, Android/iOS/EAS, Nix, website, or relay
build artifacts. Those upstream release paths are not part of this repository's
release contract.

## Troubleshooting

- **The web UI loads but cannot connect**: if `PASEO_PASSWORD` is set, add a
  direct connection with the same password.
- **403 Host not allowed**: set `PASEO_HOSTNAMES` to the DNS names you use.
- **Provider not available**: install that agent CLI in a child image or mount a
  runtime where the binary is on `PATH`.
- **Permission errors in `/workspace`**: make the mounted directory writable by
  uid/gid `1000:1000`, or run the container as the host uid/gid.
- **Logs**: inspect `docker logs paseo` or `/home/paseo/.paseo/daemon.log` inside
  the container.
