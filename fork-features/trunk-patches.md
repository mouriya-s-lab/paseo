# Trunk patches

These are the smallest integration edits that currently cannot live entirely in
`fork-features/`. Recheck each entry after an upstream sync. If Paseo adds a
registration seam or native equivalent, move the behavior out of the trunk
patch and delete the entry.

## Self-hosted connections

The behavior lives in `packages/app/src/fork-features/self-hosted/`: `runtime.ts`
(manifest, reconciliation, stored managed ids, endpoint overrides) and
`bootstrap.ts` (manifest boot, retry loop, runtime connection projection). The
reverse proxy that serves `/_paseo/hosts.json` and strips `/daemons/<id>` before
forwarding to each daemon is owned by `mouriya-s-lab/homelab-apps`
(`stacks/paseo/`), not by this repository.

| File                                               | Symbol or surface                               | Why a trunk patch remains                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/runtime/host-runtime.ts`         | `HostRuntimeController`, `HostRuntimeStore`     | The controller has no connection-filter seam: its constructor and `updateHost` store `selfHostedRuntimeHost(host)`, and `forgetRemovedConnections` closes an active connection the manifest removed. `runBoot` hands self-hosted builds to `SelfHostedBootstrap`. |
| `packages/app/src/types/host-connection.ts`        | `HostConnection`, stored registry normalization | The storage parser has no extension seam. The directTcp branch takes its id from `storedDirectTcpConnectionId` and keeps `basePath`, so old direct TCP records stay valid.                                                                                        |
| `packages/app/src/stores/download-store.ts`        | `resolveDaemonDownloadTarget`                   | Downloads derive HTTP URLs directly and expose no transport strategy registry.                                                                                                                                                                                    |
| `packages/app/src/utils/test-daemon-connection.ts` | direct TCP branch of `buildClientConfig`        | Probe clients construct WebSocket URLs directly and expose no transport strategy registry.                                                                                                                                                                        |
| `packages/protocol/src/daemon-endpoints.ts`        | `buildDaemonWebSocketUrl`                       | The shared URL builder has no provider registration API; proxy paths must be validated at this boundary.                                                                                                                                                          |
| `packages/protocol/src/host-connection-schema.ts`  | `DirectTcpHostConnectionSchema`                 | The shared schema has no extension API; `basePath` is optional to preserve protocol/storage compatibility.                                                                                                                                                        |

## Docker-only integration

| File                                               | Symbol or surface                            | Why a trunk patch remains                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker/base/Dockerfile`                           | source-pack build arguments and version gate | The Dockerfile has no build-hook registration seam. The fork must pass its web-build environment and reject version drift.                            |
| `packages/app/src/hooks/use-file-download.ts`      | `useFileDownload`                            | The download action has no transport-binding seam. The fork passes the active connection id so managed paths stay paired.                             |
| `packages/app/src/utils/workspace-script-links.ts` | `buildDirectServiceUrl`                      | Workspace service URLs have no connection projection seam. A managed proxy path cannot expose a raw service port, and TLS must follow the connection. |

The old build-time crypto replacement is intentionally absent because upstream
already fixed that recursion in `2fed0f09bb96d804285902702b192a7bf09be665`.
The old `#tcp=` and `EXPO_PUBLIC_LOCAL_DAEMON=self-hosted` behavior is
implemented by `readSelfHostedLocalDaemonOverride` in `runtime.ts`; the host
runtime's `readConfiguredLocalDaemonOverride` keeps its upstream call sites and
only delegates to it.

Verification for each rebase:

- `npm run typecheck`
- the focused self-hosted runtime and protocol tests
- the Docker image smoke path, including the web UI's same-origin daemon connection

## OMP exact MCP preapproval

Hub attaches an exact `toolPolicy` for its injected `hub` MCP server to every
execution agent, and the daemon rejects providers whose contract lacks exact
preapproval. Upstream grants it only to Claude, Codex, and OpenCode, so a Hub
workflow cannot run OMP. OMP bridges MCP tools as RPC host tools, and its
approval gate gives host tools the `exec` tier: only mode `full`
(`--approval-mode yolo`) runs them without a prompt. The rule lives in
`packages/server/src/fork-features/omp-exact-mcp-preapproval/policy.ts`, which
rejects a tool policy in any other mode.

| File                                                      | Symbol or surface                                           | Why a trunk patch remains                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/server/src/server/agent/provider-registry.ts`   | `PROVIDER_CONTRACTS.omp`                                    | Built-in provider contracts are a closed constant with no registration seam.                                                                     |
| `packages/server/src/server/agent/providers/omp/agent.ts` | `createSession`, `resumeSession`, `OmpAgentSession.setMode` | The contract hook receives no mode, so the session must refuse a tool policy outside `full` where the mode is resolved, including mode switches. |

Verification for each rebase:

- `npx vitest run src/fork-features/omp-exact-mcp-preapproval/policy.test.ts --bail=1` in `packages/server`
- a Hub workflow run with an OMP agent that calls `hub.finish_execution`

## Removed upstream automation

The fork publishes Docker only, so upstream automation for npm, Nix, relay,
website, Desktop, Android/EAS, release-note synchronization, and path filtering
is intentionally absent, together with upstream's own `docker.yml` and its
manual release skills. The deleted paths are the `fork-deleted` rows in
[`ownership.tsv`](ownership.tsv). Do not restore them unless the fork release
boundary changes.

Upstream documentation (`README*.md`, `docs/`, `public-docs/`, `docker/`
examples) is kept byte-identical to upstream so that syncs merge cleanly. Fork
release and deployment notes live in [`README.md`](README.md) instead.

`.github/workflows/sync-upstream.yml` plans each sync with
[`upstream-sync/sync-merge.mjs`](upstream-sync/sync-merge.mjs), which reads
those rows from the fork base. When upstream edits a `fork-deleted` path, the
sync merge keeps it deleted. Any other conflict goes to the review PR. So does
any `.github/workflows/` file that upstream adds and the fork base lacks: when
you review it, either delete it and add a `fork-deleted` row, or keep it as a
fork-owned workflow.
