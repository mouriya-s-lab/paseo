---
name: release-beta
description: Inspect the automatic prerelease Docker publication for this fork. Use when the user asks about a beta release.
user-invocable: true
---

# Fork prerelease

This fork does not run a manual beta release command. Read `docs/release.md`.
The Docker workflow derives the upstream prerelease base and creates the next
`vX.Y.Z-<identifier>-fork.N` tag automatically after `main` is published and
the image succeeds. It publishes only the exact prerelease image tag and never
moves `latest`.
