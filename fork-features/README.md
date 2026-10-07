# Fork notes

This repository is `mouriya-s-lab/paseo`, a fork of `getpaseo/paseo`. Why it
exists and what it may not break is stated in
[`.claude/rules/paseo-fork-purpose.rule.md`](../.claude/rules/paseo-fork-purpose.rule.md).
Everything under `docs/`, `public-docs/`, `README*.md` and `docker/README.md`
is upstream's text and describes upstream's own release and distribution. This
file covers what differs in the fork.

Fork files live under `fork-features/` (root) or `<package>/src/fork-features/`
(code that must be bundled by its package). [`ownership.tsv`](ownership.tsv)
lists every path the fork owns, deletes, or patches;
[`trunk-patches.md`](trunk-patches.md) explains each remaining edit to an
upstream file.

## Release

The fork publishes two Docker images, one per role of the split deployment,
always as a pair under the same tag:

- `registry.237575.xyz/paseo/paseo` — the daemon, from
  [`docker/base/Dockerfile`](../docker/base/Dockerfile).
- `registry.237575.xyz/paseo/paseo-web` — the web origin, from
  [`web-image/Dockerfile`](web-image/Dockerfile). See
  [Split web/daemon deployment](#split-webdaemon-deployment).

It builds no npm, Desktop, Android/iOS/EAS, Nix, website, relay, or GitHub
Release artifacts, and upstream's release workflows and skills are deleted.

[`.github/workflows/fork-docker.yml`](../.github/workflows/fork-docker.yml) is
the only release workflow. It runs on the GARM edge runner on the CachyOS laptop
(`runs-on` includes `cachyos`, which only the edge pool carries): the resident
VM 181 runners share 4 GiB and `expo export --platform web` is OOM-killed there.
The label is owned by `mouriya-s-lab/pve-vctcn` `apps/runner`.

- A same-repository pull request builds both images without pushing.
- A push to `main`, the hourly schedule, and a manual dispatch on `main` publish
  the current fork release.
- Pull requests from other repositories never run on the mesh runner.

Both images build sequentially in one job. Both exact tags are pushed and their
revision labels verified before either `latest` moves, and the Git tag is
created last, so a failed build or push leaves no release tag and a retry
publishes the whole pair. Deployments pin the exact tag, not `latest`.

### Versions

[`release/fork-release-version.mjs`](release/fork-release-version.mjs) picks the
highest upstream release tag reachable from the commit (`vX.Y.Z` or
`vX.Y.Z-<identifier>`). The root `package.json` version must equal it, and both
Dockerfiles assert this again through `PASEO_VERSION`. The fork tag is
`v<base>-fork.N`, with `N` starting at `0` per base and reused when the same
commit is retried. Image tags drop the leading `v`. A stable base also moves
`latest`; a prerelease never does.

Release builds pass the image tag as `PASEO_FORK_VERSION` to both Dockerfiles,
which inline it as `EXPO_PUBLIC_PASEO_FORK_VERSION`; Settings → About shows it
in place of the base version. Everything else that compares versions (daemon
handshake, changelog, mismatch warnings) keeps the `package.json` base version.
Build-only runs pass nothing and show the base version.

Inspect the resolver without tagging or publishing:

```bash
node fork-features/release/fork-release-version.mjs --ref HEAD
```

Retry a failed release by re-running the `main` workflow run or dispatching it
again. Never create or move a `v*` tag by hand: `v*` belongs to upstream, the
fork uses `v*-fork.N`.

## Upstream sync

Upstream enters `main` only through
[`.github/workflows/sync-upstream.yml`](../.github/workflows/sync-upstream.yml),
planned by [`upstream-sync/sync-merge.mjs`](upstream-sync/sync-merge.mjs). The
planner merges the longest run of upstream commits that needs no review, keeping
`fork-deleted` paths deleted. That candidate is built by `fork-docker.yml` in
build-only mode (`workflow_call` with `ref`); if both images build, the workflow
fast-forwards `main` to it without a PR, and the `main` push publishes as usual.
A PR labeled `upstream-sync` opens only when a human is needed: a conflict
outside the `fork-deleted` paths, a new upstream workflow file (`sync/review`),
or a candidate that failed to build (`sync/merge`). While such a PR is open,
sync runs skip.

## Split web/daemon deployment

The browser bundle built with `EXPO_PUBLIC_PASEO_SELFHOSTED=true` reads
`/_paseo/hosts.json` from its own origin and connects to each daemon through
`/daemons/<id>/`:

```json
[{ "id": "alpha", "label": "Alpha", "basePath": "/daemons/alpha" }]
```

The code is in
[`packages/app/src/fork-features/self-hosted/`](../packages/app/src/fork-features/self-hosted/).

The web image serves that bundle with nginx on port 6767. At startup,
[`web-image/generate-config.mjs`](web-image/generate-config.mjs) reads the
daemon inventory from `/etc/paseo/daemons.json`, validates it, and writes the
nginx routes and `/_paseo/hosts.json`; an invalid inventory stops the container
before nginx starts. Each inventory entry has exactly these fields:

```json
[{ "id": "alpha", "label": "Alpha", "upstream": "http://192.168.1.10:6767" }]
```

`id` is a lowercase slug, `upstream` an `http` origin without credentials or
path. The proxy strips `/daemons/<id>` and rewrites `Host` and `Origin` to the
upstream, so daemons need no CORS entry for the web origin. The manifest has no
password field: a daemon behind the web image must accept unauthenticated
connections from the proxy.

The deployment owns the inventory. `mouriya-s-lab/homelab-apps`
`stacks/paseo/compose.yaml` declares it inline as a Compose `configs` entry
mounted at `/etc/paseo/daemons.json`. Changing the inventory needs a new
container, not a new image: Compose does not detect a changed `configs.content`,
so recreate explicitly (`docker compose up -d --force-recreate web`; the Komodo
Stack passes `--force-recreate`). Browsers pick up the change on their next
load.
