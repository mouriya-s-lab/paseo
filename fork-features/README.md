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

The fork publishes one artifact: the Docker image
`registry.237575.xyz/paseo/paseo`. It builds no npm, Desktop, Android/iOS/EAS,
Nix, website, relay, or GitHub Release artifacts, and upstream's release
workflows and skills are deleted.

[`.github/workflows/fork-docker.yml`](../.github/workflows/fork-docker.yml) is
the only release workflow. It runs on the GARM edge runner on the CachyOS laptop
(`runs-on` includes `cachyos`, which only the edge pool carries): the resident
VM 181 runners share 4 GiB and `expo export --platform web` is OOM-killed there.
The label is owned by `mouriya-s-lab/pve-vctcn` `apps/runner`.

- A same-repository pull request builds the image without pushing.
- A push to `main`, the hourly schedule, and a manual dispatch on `main` publish
  the current fork release.
- Pull requests from other repositories never run on the mesh runner.

The image is pushed before the Git tag is created, so a failed build leaves no
release tag.

### Versions

[`release/fork-release-version.mjs`](release/fork-release-version.mjs) picks the
highest upstream release tag reachable from the commit (`vX.Y.Z` or
`vX.Y.Z-<identifier>`). The root `package.json` version must equal it, and the
Dockerfile asserts this again through `PASEO_VERSION`. The fork tag is
`v<base>-fork.N`, with `N` starting at `0` per base and reused when the same
commit is retried. Image tags drop the leading `v`. A stable base also moves
`latest`; a prerelease never does.

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
planner keeps `fork-deleted` paths deleted and sends any other conflict, and any
new upstream workflow file, to a review PR.

## Split web/daemon deployment

The browser bundle built with `EXPO_PUBLIC_PASEO_SELFHOSTED=true` reads
`/_paseo/hosts.json` from its own origin and connects to each daemon through
`/daemons/<id>/`:

```json
[{ "id": "alpha", "label": "Alpha", "basePath": "/daemons/alpha" }]
```

The code is in
[`packages/app/src/fork-features/self-hosted/`](../packages/app/src/fork-features/self-hosted/).
The reverse proxy and the manifest belong to the deployment,
`mouriya-s-lab/homelab-apps` `stacks/paseo/`.

## Operator Mac daemon

The Mac mini daemon (`~/.paseo`, enrolled in the self-hosted Hub as `macmini`)
runs this fork, built locally from a pinned commit, because Hub workflows use
omp and only the fork accepts Hub's exact MCP preapproval for omp (see
[`trunk-patches.md`](trunk-patches.md)). It is a local build, not a published
artifact. The desktop app stays installed as a client with
`manageBuiltInDaemon: false`, so it never starts its bundled daemon on the same
home.

```bash
fork-features/macos-daemon/install.sh <git-ref>            # launchd LaunchAgent sh.paseo.fork-daemon
fork-features/macos-daemon/install.sh --session <git-ref>  # detached from this terminal
```

Each commit builds once into `~/.local/share/paseo-fork-daemon/releases/<sha>`;
`current` points at the running one and `bin/paseo` is the CLI that agents and
the github-agent-router SSH gate call. The agents' checkouts sit on the separate
`~/Ext` volume, which macOS privacy blocks for launchd-started processes until
the operator allows the pinned node binary once in System Settings > Privacy &
Security. Before that, use `--session` from a terminal that already has access;
that daemon does not survive a logout or reboot.
