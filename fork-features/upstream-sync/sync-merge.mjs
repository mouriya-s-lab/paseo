#!/usr/bin/env node
// Fork-owned upstream sync planner used by .github/workflows/sync-upstream.yml.
//
// Upstream keeps editing files the fork deleted on purpose (fork-deleted rows in
// fork-features/ownership.tsv). Git reports each such edit as a modify/delete
// conflict, which used to stop every automatic sync. This planner merges the
// fork base with upstream and accepts exactly one kind of conflict: the fork
// deleted a fork-deleted path and upstream modified it. Those paths stay
// deleted in a synthesized merge commit (parents: base, upstream). Any other
// conflict, and any upstream workflow file the fork base does not have, goes to
// human review.
//
// The allowlist is read from the base commit, never from the upstream side, so
// an upstream edit to ownership.tsv cannot authorize its own resolution.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OWNERSHIP_PATH = "fork-features/ownership.tsv";
const FORK_DELETED_STATUS = "fork-deleted";
const WORKFLOW_DIR = ".github/workflows/";
const MODIFY_DELETE = "CONFLICT (modify/delete)";

const USAGE =
  "Usage: node fork-features/upstream-sync/sync-merge.mjs --base <commit> --upstream <commit>\n" +
  "Prints one JSON plan: {outcome, base, upstream, target, mergeCommit, deletedPaths, blocked}.\n" +
  "outcome: up-to-date | full | prefix | none";

/** @param {string} tsv */
export function parseForkDeletedPaths(tsv) {
  const paths = new Set();
  for (const line of tsv.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const [filePath, status] = line.split("\t");
    if (status === FORK_DELETED_STATUS && filePath) {
      paths.add(filePath);
    }
  }
  return paths;
}

/**
 * Parses `git merge-tree --write-tree -z` output.
 * @param {string} output
 * @returns {{ tree: string, entries: {mode: string, oid: string, stage: number, path: string}[], messages: {paths: string[], type: string, message: string}[] }}
 */
export function parseMergeTreeOutput(output) {
  const tokens = output.split("\0");
  const tree = tokens[0];
  if (!/^[0-9a-f]{40,64}$/u.test(tree ?? "")) {
    throw new Error(`Unexpected merge-tree output: ${JSON.stringify(output.slice(0, 120))}`);
  }
  const entries = [];
  let index = 1;
  for (; index < tokens.length && tokens[index] !== ""; index += 1) {
    const match = tokens[index].match(/^(\d{6}) ([0-9a-f]{40,64}) ([123])\t(.+)$/su);
    if (!match) {
      throw new Error(`Unexpected conflicted file entry: ${JSON.stringify(tokens[index])}`);
    }
    entries.push({ mode: match[1], oid: match[2], stage: Number(match[3]), path: match[4] });
  }
  index += 1; // the empty token that ends the conflicted-file section

  const messages = [];
  while (index < tokens.length && tokens[index] !== "") {
    const count = Number(tokens[index]);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Unexpected merge-tree message header: ${JSON.stringify(tokens[index])}`);
    }
    const paths = tokens.slice(index + 1, index + 1 + count);
    const type = tokens[index + 1 + count];
    const message = tokens[index + 2 + count];
    if (paths.length !== count || type === undefined || message === undefined) {
      throw new Error("Truncated merge-tree message section");
    }
    messages.push({ paths, type, message });
    index += count + 3;
  }
  return { tree, entries, messages };
}

/**
 * Decides whether a merge-tree result is auto-resolvable.
 * @param {ReturnType<typeof parseMergeTreeOutput>} merge
 * @param {Set<string>} forkDeletedPaths
 * @returns {{ resolvable: true, deletedPaths: string[] } | { resolvable: false, reasons: string[] }}
 */
export function classifyMerge(merge, forkDeletedPaths) {
  const stagesByPath = new Map();
  for (const entry of merge.entries) {
    const stages = stagesByPath.get(entry.path) ?? new Set();
    stages.add(entry.stage);
    stagesByPath.set(entry.path, stages);
  }

  const reasons = [];
  const deletedPaths = [];
  for (const [filePath, stages] of stagesByPath) {
    const oursDeletedTheirsKept = stages.has(1) && !stages.has(2) && stages.has(3);
    if (!forkDeletedPaths.has(filePath)) {
      reasons.push(`conflict on ${filePath} (not fork-deleted)`);
    } else if (!oursDeletedTheirsKept) {
      reasons.push(`conflict on fork-deleted ${filePath} is not fork-delete/upstream-modify`);
    } else {
      deletedPaths.push(filePath);
    }
  }

  for (const message of merge.messages) {
    if (!message.type.startsWith("CONFLICT")) {
      continue;
    }
    const acceptedModifyDelete =
      message.type === MODIFY_DELETE &&
      message.paths.length === 1 &&
      deletedPaths.includes(message.paths[0]);
    if (!acceptedModifyDelete) {
      reasons.push(`${message.type} on ${message.paths.join(", ")}`);
    }
  }

  if (reasons.length > 0) {
    return { resolvable: false, reasons: [...new Set(reasons)] };
  }
  return { resolvable: true, deletedPaths: deletedPaths.sort() };
}

function createGit(cwd) {
  const run = (args, options = {}) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...options.env },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) {
      throw result.error;
    }
    if (!(options.allowedStatus ?? [0]).includes(result.status)) {
      throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
    }
    return { stdout: result.stdout, status: result.status };
  };
  return {
    run,
    out: (args, options) => run(args, options).stdout.trim(),
  };
}

function readForkDeletedPaths(git, base) {
  const listed = git.run(["cat-file", "-e", `${base}:${OWNERSHIP_PATH}`], {
    allowedStatus: [0, 1, 128],
  });
  if (listed.status !== 0) {
    return new Set();
  }
  return parseForkDeletedPaths(git.out(["show", `${base}:${OWNERSHIP_PATH}`]));
}

function treeWithoutPaths(git, tree, paths) {
  if (paths.length === 0) {
    return tree;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "sync-merge-index-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    git.run(["read-tree", tree], { env });
    git.run(["update-index", "--force-remove", "--", ...paths], { env });
    return git.out(["write-tree"], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function addedWorkflowPaths(git, base, tree) {
  const output = git.out([
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    "--name-only",
    "--diff-filter=A",
    base,
    tree,
    "--",
    WORKFLOW_DIR,
  ]);
  return output.split("\0").filter((entry) => entry.length > 0);
}

/**
 * Tries to merge `upstream` into `base`. Returns the resolved tree or why it needs review.
 */
export function evaluateMerge({ git, base, upstream, forkDeletedPaths }) {
  const result = git.run(["merge-tree", "--write-tree", "-z", base, upstream], {
    allowedStatus: [0, 1],
  });
  const merge = parseMergeTreeOutput(result.stdout);
  const classification = classifyMerge(merge, forkDeletedPaths);
  if (!classification.resolvable) {
    return classification;
  }
  const tree = treeWithoutPaths(git, merge.tree, classification.deletedPaths);
  const newWorkflows = addedWorkflowPaths(git, base, tree);
  if (newWorkflows.length > 0) {
    return {
      resolvable: false,
      reasons: newWorkflows.map((filePath) => `new upstream workflow ${filePath}`),
    };
  }
  return { resolvable: true, tree, deletedPaths: classification.deletedPaths };
}

function commitMerge({ git, base, upstream, tree, deletedPaths }) {
  const subject = `Merge upstream ${upstream.slice(0, 12)} into fork`;
  const body =
    deletedPaths.length === 0
      ? ""
      : `\n\nKept fork-deleted paths deleted:\n${deletedPaths.map((p) => `- ${p}`).join("\n")}`;
  return git.out(["commit-tree", tree, "-p", base, "-p", upstream, "-m", `${subject}${body}`]);
}

/**
 * Plans the next sync: the whole upstream batch, its longest auto-resolvable prefix, or nothing.
 */
export function planSync({ cwd, base: baseRef, upstream: upstreamRef }) {
  const git = createGit(cwd);
  const base = git.out(["rev-parse", "--verify", `${baseRef}^{commit}`]);
  const upstream = git.out(["rev-parse", "--verify", `${upstreamRef}^{commit}`]);
  const plan = {
    outcome: "up-to-date",
    base,
    upstream,
    target: null,
    mergeCommit: null,
    deletedPaths: [],
    blocked: null,
  };
  const upToDate = git.run(["merge-base", "--is-ancestor", upstream, base], {
    allowedStatus: [0, 1],
  });
  if (upToDate.status === 0) {
    return plan;
  }

  const forkDeletedPaths = readForkDeletedPaths(git, base);
  const full = evaluateMerge({ git, base, upstream, forkDeletedPaths });
  if (full.resolvable) {
    return {
      ...plan,
      outcome: "full",
      target: upstream,
      mergeCommit: commitMerge({ git, base, upstream, ...full }),
      deletedPaths: full.deletedPaths,
    };
  }

  let accepted = null;
  let blocked = null;
  const commits = git
    .out(["rev-list", "--reverse", `${base}..${upstream}`])
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    const step = evaluateMerge({ git, base, upstream: commit, forkDeletedPaths });
    if (!step.resolvable) {
      blocked = { commit, reasons: step.reasons };
      break;
    }
    accepted = { commit, ...step };
  }

  if (!accepted) {
    return { ...plan, outcome: "none", blocked };
  }
  return {
    ...plan,
    outcome: "prefix",
    target: accepted.commit,
    mergeCommit: commitMerge({ git, base, upstream: accepted.commit, ...accepted }),
    deletedPaths: accepted.deletedPaths,
    blocked,
  };
}

function parseArgs(argv) {
  const args = { base: null, upstream: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base" || arg === "--upstream") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a commit`);
      }
      args[arg.slice(2)] = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      return null;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.base || !args.upstream) {
    throw new Error("--base and --upstream are required");
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exit(2);
  }
  if (!args) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  process.stdout.write(`${JSON.stringify(planSync({ cwd, ...args }))}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
