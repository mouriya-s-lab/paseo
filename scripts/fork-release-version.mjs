#!/usr/bin/env node
// Fork-owned release resolver: selects the highest reachable upstream release
// tag and allocates a deterministic fork tag (v<base>-fork.N) for it.
// Only git CLI output is treated as untrusted input; everything else is pure.

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_IDENTIFIER_RE = /^\d+$/;
const CANONICAL_NON_NEGATIVE_INT_RE = /^(0|[1-9]\d*)$/;
const FORK_LIKE_RE = /^v.+-fork\.\d+$/;
const FORK_TAG_RE = /^v(.+)-fork\.(\d+)$/;

const USAGE =
  "Usage: node scripts/fork-release-version.mjs [--ref <commit>] [--fetch] [--remote <name>] [<commit>]\n" +
  "Resolves the highest reachable upstream release tag and prints one JSON object:\n" +
  '{"releaseTag","imageTag","baseVersion","upstreamTag","publishLatest","alreadyPublished"}';

export function parseVersion(input) {
  if (typeof input !== "string") {
    throw new Error(`Invalid version: expected a string, got ${typeof input}.`);
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('Invalid version "". Expected X.Y.Z or X.Y.Z-prerelease.');
  }
  const match = trimmed.match(VERSION_RE);
  if (!match) {
    throw new Error(
      `Invalid version "${input}". Expected strict semver like 0.7.2 or 0.7.2-beta.1.`,
    );
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  const prerelease = match[4] ?? null;
  let prereleaseIdentifiers = null;
  if (prerelease !== null) {
    prereleaseIdentifiers = prerelease.split(".");
    for (const identifier of prereleaseIdentifiers) {
      if (
        NUMERIC_IDENTIFIER_RE.test(identifier) &&
        !CANONICAL_NON_NEGATIVE_INT_RE.test(identifier)
      ) {
        throw new Error(
          `Invalid version "${input}". Numeric prerelease identifier "${identifier}" must not have leading zeros.`,
        );
      }
    }
  }
  const version =
    prerelease === null ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch}-${prerelease}`;
  return {
    version,
    major,
    minor,
    patch,
    prerelease,
    prereleaseIdentifiers,
    isPrerelease: prerelease !== null,
  };
}

export function parseUpstreamTag(tag) {
  if (typeof tag !== "string") {
    return null;
  }
  const trimmed = tag.trim();
  if (!trimmed.startsWith("v")) {
    return null;
  }
  if (FORK_LIKE_RE.test(trimmed)) {
    return null;
  }
  let parsed = null;
  try {
    parsed = parseVersion(trimmed.slice(1));
  } catch {
    return null;
  }
  return {
    upstreamTag: trimmed,
    version: parsed.version,
    baseVersion: parsed.version,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: parsed.prerelease,
    prereleaseIdentifiers: parsed.prereleaseIdentifiers,
    isPrerelease: parsed.isPrerelease,
    isStable: !parsed.isPrerelease,
  };
}

export function parseForkTag(tag) {
  if (typeof tag !== "string") {
    return null;
  }
  const trimmed = tag.trim();
  const match = trimmed.match(FORK_TAG_RE);
  if (!match) {
    return null;
  }
  if (!CANONICAL_NON_NEGATIVE_INT_RE.test(match[2])) {
    return null;
  }
  let base = null;
  try {
    base = parseVersion(match[1]);
  } catch {
    return null;
  }
  if (base.version !== match[1]) {
    return null;
  }
  const suffix = Number.parseInt(match[2], 10);
  return {
    releaseTag: trimmed,
    baseVersion: base.version,
    suffix,
    upstreamTag: `v${base.version}`,
  };
}

function compareNumbers(a, b) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function comparePrereleaseIdentifier(a, b) {
  if (a === b) {
    return 0;
  }
  const aNumeric = NUMERIC_IDENTIFIER_RE.test(a);
  const bNumeric = NUMERIC_IDENTIFIER_RE.test(b);
  if (aNumeric && bNumeric) {
    if (a.length !== b.length) {
      return a.length < b.length ? -1 : 1;
    }
    return a < b ? -1 : 1;
  }
  if (aNumeric) {
    return -1;
  }
  if (bNumeric) {
    return 1;
  }
  return a < b ? -1 : 1;
}

function comparePrereleaseIdentifiers(a, b) {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= a.length) {
      return -1;
    }
    if (index >= b.length) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifier(a[index], b[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

export function compareVersions(a, b) {
  const major = compareNumbers(a.major, b.major);
  if (major !== 0) {
    return major;
  }
  const minor = compareNumbers(a.minor, b.minor);
  if (minor !== 0) {
    return minor;
  }
  const patch = compareNumbers(a.patch, b.patch);
  if (patch !== 0) {
    return patch;
  }
  return comparePrereleaseIdentifiers(a.prereleaseIdentifiers, b.prereleaseIdentifiers);
}

export function chooseUpstreamRelease(candidates) {
  if (!Array.isArray(candidates)) {
    throw new Error("upstreamCandidates must be an array.");
  }
  const reachable = [];
  for (const entry of candidates) {
    if (
      !entry ||
      typeof entry.tag !== "string" ||
      typeof entry.commit !== "string" ||
      entry.commit.trim().length === 0
    ) {
      throw new Error(
        "Each upstream candidate must have { tag: string, commit: string, reachable: boolean }.",
      );
    }
    if (entry.reachable !== true) {
      continue;
    }
    const parsed = parseUpstreamTag(entry.tag);
    if (!parsed) {
      continue;
    }
    reachable.push({ ...parsed, commit: entry.commit.trim() });
  }
  if (reachable.length === 0) {
    throw new Error("No reachable upstream release tag found.");
  }
  reachable.sort((x, y) => {
    const order = compareVersions(x, y);
    if (order !== 0) {
      return -order;
    }
    if (x.upstreamTag === y.upstreamTag) {
      return 0;
    }
    return x.upstreamTag < y.upstreamTag ? -1 : 1;
  });
  return reachable[0];
}

export function allocateForkRelease({ baseVersion, currentCommit, forkTags }) {
  if (typeof baseVersion !== "string" || baseVersion.trim().length === 0) {
    throw new Error("baseVersion must be a non-empty version string.");
  }
  const base = parseVersion(baseVersion.trim());
  if (typeof currentCommit !== "string" || currentCommit.trim().length === 0) {
    throw new Error("currentCommit must be a non-empty commit SHA.");
  }
  const current = currentCommit.trim();
  if (!Array.isArray(forkTags)) {
    throw new Error("forkTags must be an array.");
  }
  let maxSuffix = -1;
  let maxSuffixAtCurrent = -1;
  for (const entry of forkTags) {
    if (!entry || typeof entry.tag !== "string" || typeof entry.commit !== "string") {
      throw new Error("Each fork tag entry must have { tag: string, commit: string }.");
    }
    const parsed = parseForkTag(entry.tag);
    if (!parsed) {
      continue;
    }
    if (parsed.baseVersion !== base.version) {
      continue;
    }
    if (parsed.suffix > maxSuffix) {
      maxSuffix = parsed.suffix;
    }
    if (entry.commit.trim() === current && parsed.suffix > maxSuffixAtCurrent) {
      maxSuffixAtCurrent = parsed.suffix;
    }
  }
  if (maxSuffixAtCurrent >= 0) {
    return { suffix: maxSuffixAtCurrent, alreadyPublished: true };
  }
  return { suffix: maxSuffix + 1, alreadyPublished: false };
}

export function chooseForkRelease({ currentCommit, upstreamCandidates, forkTags }) {
  if (typeof currentCommit !== "string" || currentCommit.trim().length === 0) {
    throw new Error("currentCommit must be a non-empty commit SHA.");
  }
  const current = currentCommit.trim();
  let selected = null;
  try {
    selected = chooseUpstreamRelease(upstreamCandidates ?? []);
  } catch (error) {
    if (error instanceof Error && error.message.includes("No reachable upstream")) {
      throw new Error(`No reachable upstream release tag found from ${current}.`, {
        cause: error,
      });
    }
    throw error;
  }
  const { suffix, alreadyPublished } = allocateForkRelease({
    baseVersion: selected.baseVersion,
    currentCommit: current,
    forkTags: forkTags ?? [],
  });
  const releaseTag = `v${selected.baseVersion}-fork.${suffix}`;
  return {
    releaseTag,
    imageTag: releaseTag.slice(1),
    baseVersion: selected.baseVersion,
    upstreamTag: selected.upstreamTag,
    publishLatest: !selected.isPrerelease,
    alreadyPublished,
  };
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runGitOutput(args) {
  try {
    const output = execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.trim();
  } catch (error) {
    const stderr =
      typeof error?.stderr === "string"
        ? error.stderr.trim()
        : error?.stderr?.toString?.().trim?.() || "";
    const detail = stderr || error?.message || String(error);
    throw new Error(`git ${args.join(" ")} failed: ${detail}`, { cause: error });
  }
}

function isAncestor(ancestorCommit, descendantCommit) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestorCommit, descendantCommit],
    {
      cwd: rootDir,
      stdio: "ignore",
    },
  );
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(
    `git merge-base --is-ancestor ${ancestorCommit} ${descendantCommit} failed with status ${result.status}: ${result.error?.message ?? ""}`,
  );
}

function listTags() {
  const output = runGitOutput(["tag", "--list"]);
  if (output.length === 0) {
    return [];
  }
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function resolveTagCommit(tag) {
  return runGitOutput(["rev-list", "-n", "1", tag]);
}

function resolveRefCommit(ref) {
  return runGitOutput(["rev-parse", "--verify", `${ref}^{commit}`]);
}

function fetchTags(remote) {
  const args = remote ? ["fetch", "--tags", remote] : ["fetch", "--tags"];
  try {
    execFileSync("git", args, { cwd: rootDir, stdio: ["ignore", "ignore", "inherit"] });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${error?.message ?? String(error)}`, {
      cause: error,
    });
  }
}

function parseNamedOption(argv, index, arg, name, valueDescription) {
  if (arg === name) {
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${name} ${valueDescription}.`);
    }
    return { value, nextIndex: index + 1 };
  }
  const prefix = `${name}=`;
  if (!arg.startsWith(prefix)) {
    return null;
  }
  const value = arg.slice(prefix.length);
  if (!value) {
    throw new Error(`Missing value for ${name}=${valueDescription}.`);
  }
  return { value, nextIndex: index };
}

function parseArgs(argv) {
  let ref = null;
  let fetch = false;
  let remote = null;
  let help = false;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const refOption = parseNamedOption(argv, index, arg, "--ref", "<commit>");
    if (refOption) {
      ref = refOption.value;
      index = refOption.nextIndex;
      continue;
    }
    const remoteOption = parseNamedOption(argv, index, arg, "--remote", "<name>");
    if (remoteOption) {
      remote = remoteOption.value;
      index = remoteOption.nextIndex;
      continue;
    }
    if (arg === "--fetch") {
      fetch = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}". ${USAGE}`);
    }
    positional.push(arg);
  }
  if (!ref && positional.length > 0) {
    ref = positional[0];
  }
  if (positional.length > 1) {
    throw new Error(`Too many commit arguments. ${USAGE}`);
  }
  if (remote && !fetch) {
    throw new Error("--remote requires --fetch.");
  }
  return { ref, fetch, remote, help };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.fetch) {
    fetchTags(args.remote);
  }
  const ref = args.ref ?? "HEAD";
  const currentCommit = resolveRefCommit(ref);
  const allTags = listTags();
  const upstreamTags = [];
  for (const tag of allTags) {
    const parsed = parseUpstreamTag(tag);
    if (parsed) {
      upstreamTags.push(parsed);
    }
  }
  const upstreamCandidates = [];
  for (const upstream of upstreamTags) {
    const commit = resolveTagCommit(upstream.upstreamTag);
    upstreamCandidates.push({
      tag: upstream.upstreamTag,
      commit,
      reachable: isAncestor(commit, currentCommit),
    });
  }
  const selected = chooseUpstreamRelease(upstreamCandidates);
  const forkEntries = [];
  for (const tag of allTags) {
    const parsed = parseForkTag(tag);
    if (!parsed || parsed.baseVersion !== selected.baseVersion) {
      continue;
    }
    forkEntries.push({ tag: parsed.releaseTag, commit: resolveTagCommit(parsed.releaseTag) });
  }
  const result = chooseForkRelease({
    currentCommit,
    upstreamCandidates,
    forkTags: forkEntries,
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
