# Fork release

This repository is a fork of `getpaseo/paseo`. It publishes one runtime
artifact: the Docker image. npm packages, Desktop, Android/iOS/EAS, Nix,
website, relay, and GitHub Release assets are not built or published by this
fork.

## Release source

The release source is the current `main` commit in this fork. The Docker
workflow fetches tags from the `upstream` remote and chooses the highest
upstream release tag reachable from that commit:

- stable: `vX.Y.Z`
- prerelease: `vX.Y.Z-<identifier>`

The root `package.json` version must equal the selected upstream version. The
Dockerfile checks this again through `PASEO_VERSION` before installing or
packing workspaces.

## Automatic release

[`.github/workflows/docker.yml`](../.github/workflows/docker.yml) is the only
release workflow. It runs on the self-hosted GARM runner with labels
`self-hosted`, `linux`, `vctcn`, `netbird`, and `x64`.

- A same-repository pull request builds a native `linux/amd64` image without
  logging in or pushing.
- Every push to `main` resolves and publishes the current fork release.
- An hourly schedule catches new upstream tags after the sync workflow lands
  them in `main`.
- A manual dispatch on `main` runs the same release path.
- Pull requests from another repository do not execute code on the mesh runner.

The workflow builds and pushes the image before creating the Git tag. A failed
build therefore does not leave an unbuilt release tag.

## Fork versioning

For upstream base version `X.Y.Z` or `X.Y.Z-<identifier>`, the resolver creates:

```text
vX.Y.Z-fork.N
vX.Y.Z-<identifier>-fork.N
```

`N` starts at `0` for each upstream base and increments from the largest
existing suffix. If that exact fork tag already points to the current commit,
retries reuse it instead of allocating another number.

Image tags omit the leading `v`:

```text
X.Y.Z-fork.N
X.Y.Z-<identifier>-fork.N
```

Stable releases also update `latest`. Prereleases never update `latest`.

Inspect the resolver without creating a tag or image:

```bash
node scripts/fork-release-version.mjs --ref HEAD
```

The command prints one JSON object with the selected upstream tag, fork tag,
image tag, base version, `latest` policy, and idempotency result. It exits nonzero
when no valid upstream release tag is reachable from the selected commit.

## Local Docker build

Use the same Dockerfile and build-time settings as Actions:

```bash
docker build \
  --build-arg PASEO_VERSION=0.7.2 \
  --build-arg EXPO_PUBLIC_PASEO_SELFHOSTED=false \
  --build-arg EXPO_PUBLIC_LOCAL_DAEMON=self-hosted \
  -f docker/base/Dockerfile \
  -t paseo:local \
  .
```

Do not add a version suffix to `package.json`. The fork suffix belongs only to
the Git tag and image tag; this keeps the source tree compatible with the
upstream workspace version.

## Retry behavior

Retry the existing `main` workflow run or dispatch the workflow again. The
resolver is idempotent for a commit that already has a fork tag. Do not create
or force-push a `v*` tag manually; `v*` is reserved for upstream release tags,
and the fork uses `v*-fork.N`.

## Fork code placement

The self-hosted App behavior is fork code under
[`packages/app/src/fork-features/self-hosted/`](../packages/app/src/fork-features/self-hosted/).
The unavoidable integration edits in upstream-owned files are recorded in
[`fork-features/trunk-patches.md`](../fork-features/trunk-patches.md).
