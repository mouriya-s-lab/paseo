import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateForkRelease,
  chooseForkRelease,
  chooseUpstreamRelease,
  parseForkTag,
  parseUpstreamTag,
} from "./fork-release-version.mjs";

test("selects the highest reachable upstream tag", () => {
  const selected = chooseUpstreamRelease([
    { tag: "v0.7.0", commit: "a".repeat(40), reachable: true },
    { tag: "v0.7.2", commit: "b".repeat(40), reachable: true },
    { tag: "v0.7.1", commit: "c".repeat(40), reachable: false },
    { tag: "not-a-release", commit: "d".repeat(40), reachable: true },
    { tag: "v0.7.3-fork.0", commit: "e".repeat(40), reachable: true },
    { tag: "v01.7.2", commit: "f".repeat(40), reachable: true },
  ]);

  assert.equal(selected.upstreamTag, "v0.7.2");
  assert.equal(selected.baseVersion, "0.7.2");
});

test("prefers stable over lower prerelease ordering and marks latest policy", () => {
  const stable = chooseForkRelease({
    currentCommit: "1".repeat(40),
    upstreamCandidates: [{ tag: "v0.7.2", commit: "a".repeat(40), reachable: true }],
    forkTags: [],
  });
  assert.deepEqual(stable, {
    releaseTag: "v0.7.2-fork.0",
    imageTag: "0.7.2-fork.0",
    baseVersion: "0.7.2",
    upstreamTag: "v0.7.2",
    publishLatest: true,
    alreadyPublished: false,
  });

  const prerelease = chooseForkRelease({
    currentCommit: "1".repeat(40),
    upstreamCandidates: [{ tag: "v0.7.3-beta.1", commit: "a".repeat(40), reachable: true }],
    forkTags: [],
  });
  assert.deepEqual(prerelease, {
    releaseTag: "v0.7.3-beta.1-fork.0",
    imageTag: "0.7.3-beta.1-fork.0",
    baseVersion: "0.7.3-beta.1",
    upstreamTag: "v0.7.3-beta.1",
    publishLatest: false,
    alreadyPublished: false,
  });
});

test("allocates max fork suffix plus one, starting at zero", () => {
  assert.deepEqual(
    allocateForkRelease({
      baseVersion: "0.7.2",
      currentCommit: "9".repeat(40),
      forkTags: [],
    }),
    { suffix: 0, alreadyPublished: false },
  );

  assert.deepEqual(
    allocateForkRelease({
      baseVersion: "0.7.2",
      currentCommit: "9".repeat(40),
      forkTags: [
        { tag: "v0.7.2-fork.0", commit: "a".repeat(40) },
        { tag: "v0.7.2-fork.2", commit: "b".repeat(40) },
        { tag: "v0.7.1-fork.9", commit: "c".repeat(40) },
      ],
    }),
    { suffix: 3, alreadyPublished: false },
  );
});

test("reuses the highest fork tag at the current commit", () => {
  const current = "c".repeat(40);
  const result = chooseForkRelease({
    currentCommit: current,
    upstreamCandidates: [{ tag: "v0.7.2", commit: "a".repeat(40), reachable: true }],
    forkTags: [
      { tag: "v0.7.2-fork.0", commit: "b".repeat(40) },
      { tag: "v0.7.2-fork.1", commit: current },
      { tag: "v0.7.2-fork.2", commit: current },
    ],
  });

  assert.equal(result.releaseTag, "v0.7.2-fork.2");
  assert.equal(result.imageTag, "0.7.2-fork.2");
  assert.equal(result.alreadyPublished, true);
});

test("fails when no reachable release exists", () => {
  assert.throws(
    () =>
      chooseForkRelease({
        currentCommit: "c".repeat(40),
        upstreamCandidates: [
          { tag: "v0.7.2", commit: "a".repeat(40), reachable: false },
          { tag: "v0.7.2-fork.0", commit: "b".repeat(40), reachable: true },
        ],
        forkTags: [],
      }),
    /No reachable upstream release tag found/,
  );
});

test("ignores invalid fork tags and non-canonical versions", () => {
  assert.equal(parseUpstreamTag("v0.7.2-fork.0"), null);
  assert.equal(parseUpstreamTag("v01.7.2"), null);
  assert.equal(parseForkTag("v0.7.2-fork.01"), null);
  assert.equal(parseForkTag("v0.7.2-fork.x"), null);
});
