# Trunk patches

These are the smallest integration edits that currently cannot live entirely in
`fork-features/`. Recheck each entry after an upstream sync. If Paseo adds a
registration seam or native equivalent, move the behavior out of the trunk
patch and delete the entry.

## Self-hosted connections

The canonical behavior comes from
`/Users/mouriya/Ext/code/homelab-apps-investigate/stacks/paseo/app.patch` at
`f5d9b093ff4e3f6c68e4df7140d809d50415f93b` (generated from Paseo
`78b285059f6ebd0b257c98bd191df4626721270a`). The homelab deployment generator
is not part of this repository; it remains owned by `homelab-apps`.

| File                                               | Symbol or surface                               | Why a trunk patch remains                                                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/runtime/host-runtime.ts`         | `HostRuntimeController`, `HostRuntimeStore`     | Host probing, bootstrap, and persistence have no registration or callback seam. The fork must wire the package-local self-hosted module into those paths. |
| `packages/app/src/types/host-connection.ts`        | `HostConnection`, stored registry normalization | The connection union and storage parser have no extension seam. `basePath` must be an optional field so old direct TCP records remain valid.              |
| `packages/app/src/stores/download-store.ts`        | `resolveDaemonDownloadTarget`                   | Downloads derive HTTP URLs directly and expose no transport strategy registry.                                                                            |
| `packages/app/src/utils/test-daemon-connection.ts` | direct TCP branch of `buildClientConfig`        | Probe clients construct WebSocket URLs directly and expose no transport strategy registry.                                                                |
| `packages/protocol/src/daemon-endpoints.ts`        | `buildDaemonWebSocketUrl`                       | The shared URL builder has no provider registration API; proxy paths must be validated at this boundary.                                                  |
| `packages/protocol/src/host-connection-schema.ts`  | `DirectTcpHostConnectionSchema`                 | The shared schema has no extension API; `basePath` is optional to preserve protocol/storage compatibility.                                                |

## Docker-only integration

| File                                               | Symbol or surface                            | Why a trunk patch remains                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker/base/Dockerfile`                           | source-pack build arguments and version gate | The Dockerfile has no build-hook registration seam. The fork must pass its web-build environment and reject version drift.                            |
| `packages/app/src/hooks/use-file-download.ts`      | `useFileDownload`                            | The download action has no transport-binding seam. The fork passes the active connection id so managed paths stay paired.                             |
| `packages/app/src/utils/workspace-script-links.ts` | `buildDirectServiceUrl`                      | Workspace service URLs have no connection projection seam. A managed proxy path cannot expose a raw service port, and TLS must follow the connection. |

The old build-time crypto replacement is intentionally absent because upstream
already fixed that recursion in `2fed0f09bb96d804285902702b192a7bf09be665`.
The old `#tcp=` and `EXPO_PUBLIC_LOCAL_DAEMON=self-hosted` behavior is now
implemented in `packages/app/src/fork-features/self-hosted/runtime.ts` and is
wired through the host runtime patch.

Verification for each rebase:

- `npm run typecheck`
- the focused self-hosted runtime and protocol tests
- the Docker image smoke path, including the web UI's same-origin daemon connection

## Removed upstream automation

The fork publishes Docker only, so upstream automation for npm, Nix, relay,
website, Desktop, Android/EAS, release-note synchronization, and path filtering
is intentionally absent. Recheck these deletions after an upstream sync; do not
restore them unless the fork release boundary changes.

Deleted workflow/config files:

- `.github/ci-paths.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/nix.yml`
- `.github/workflows/nix-update-hash.yml`
- `.github/workflows/release-notes-sync.yml`
- `.github/workflows/deploy-relay.yml`
- `.github/workflows/deploy-website.yml`
- `.github/workflows/desktop-release.yml`
- `.github/workflows/desktop-rollout.yml`
- `.github/workflows/android-apk-release.yml`
- `.github/workflows/deploy-app.yml`
- `packages/app/.eas/workflows/release-ios-beta.yml`
- `packages/app/.eas/workflows/release-mobile.yml`
- `packages/app/.eas/workflows/resubmit-ios-review.yml`
- `scripts/ci-workflow.test.mjs`
