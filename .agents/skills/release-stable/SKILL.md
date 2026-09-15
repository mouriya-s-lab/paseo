---
name: release-stable
description: Inspect the automatic stable Docker publication for this fork. Use when the user asks about a stable release.
user-invocable: true
---

# Fork stable release

This fork does not run a manual release command. Read `docs/release.md`.
The Docker workflow derives the highest reachable stable upstream base and
creates the next `vX.Y.Z-fork.N` tag automatically after `main` is published
and the image succeeds. It publishes the immutable versioned image and updates
`latest`.
