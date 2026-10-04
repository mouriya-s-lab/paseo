import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMergeTreeOutput, planSync } from "./sync-merge.mjs";

const OWNERSHIP_PATH = "fork-features/ownership.tsv";
const DELETED_PATH = "docs/deleted.md";
const CONFLICT_PATH = "content.txt";
const CLI_PATH = fileURLToPath(new URL("./sync-merge.mjs", import.meta.url));
const forkDeletedRow = (filePath) => `${filePath}\tfork-deleted\tRemoved by the fork\n`;

function createRepo(t, files = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "sync-merge-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const updateFiles = (changes) => {
    for (const [filePath, content] of Object.entries(changes)) {
      const destination = path.join(cwd, filePath);
      if (content === null) {
        rmSync(destination);
      } else {
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, content);
      }
    }
  };
  git("init", "--quiet", "--initial-branch=fork", "--template=");
  git("config", "user.name", "Sync planner test");
  git("config", "user.email", "sync-planner@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.autocrlf", "false");
  git("config", "core.hooksPath", path.join(cwd, ".git", "hooks"));
  updateFiles({
    [OWNERSHIP_PATH]: "",
    [DELETED_PATH]: "common deleted-path content\n",
    [CONFLICT_PATH]: "common content\n",
    "ordinary.txt": "common ordinary content\n",
    ...files,
  });
  git("add", "--all");
  git("commit", "--quiet", "-m", "Common base");
  const common = git("rev-parse", "HEAD");
  git("branch", "up", common);
  const commit = (branch, changes, message) => {
    git("checkout", "--quiet", branch);
    updateFiles(changes);
    git("add", "--all");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { cwd, git, commit, common };
}

function assertMergeCommit(repo, mergeCommit, base, upstream) {
  assert.match(mergeCommit, /^[0-9a-f]{40,64}$/u);
  assert.deepEqual(repo.git("rev-list", "--parents", "-n1", mergeCommit).split(" "), [
    mergeCommit,
    base,
    upstream,
  ]);
  assert.equal(repo.git("cat-file", "-t", mergeCommit), "commit");
}

function assertFull(repo, plan, base, upstream, deletedPaths = []) {
  assert.equal(plan.outcome, "full");
  assert.equal(plan.base, base);
  assert.equal(plan.upstream, upstream);
  assert.equal(plan.target, upstream);
  assert.deepEqual(plan.deletedPaths, deletedPaths);
  assert.equal(plan.blocked, null);
  assertMergeCommit(repo, plan.mergeCommit, base, upstream);
}

function assertNone(plan, base, upstream, reasons) {
  assert.equal(plan.outcome, "none");
  assert.equal(plan.base, base);
  assert.equal(plan.upstream, upstream);
  assert.equal(plan.target, null);
  assert.equal(plan.mergeCommit, null);
  assert.deepEqual(plan.deletedPaths, []);
  assert.deepEqual(plan.blocked, { commit: upstream, reasons });
}

function assertPathAbsent(repo, commit, filePath) {
  assert.equal(repo.git("ls-tree", "-r", "--name-only", commit, "--", filePath), "");
}

test("clean ordinary merge preserves the merge-tree tree and ordered parents", (t) => {
  const repo = createRepo(t);
  const base = repo.commit("fork", { "fork.txt": "fork content\n" }, "Fork change");
  const upstream = repo.commit("up", { "ordinary.txt": "upstream content\n" }, "Upstream change");

  const plan = planSync({ cwd: repo.cwd, base, upstream });

  assertFull(repo, plan, base, upstream);
  assert.equal(
    repo.git("rev-parse", `${plan.mergeCommit}^{tree}`),
    repo.git("merge-tree", "--write-tree", base, upstream),
  );
  assert.equal(repo.git("show", `${plan.mergeCommit}:fork.txt`), "fork content");
  assert.equal(repo.git("show", `${plan.mergeCommit}:ordinary.txt`), "upstream content");
});

test("allowlisted fork deletion remains deleted while other upstream batch changes land", (t) => {
  const repo = createRepo(t);
  const base = repo.commit(
    "fork",
    {
      [DELETED_PATH]: null,
      [OWNERSHIP_PATH]: forkDeletedRow(DELETED_PATH),
    },
    "Fork deletion and ownership",
  );
  const upstream = repo.commit(
    "up",
    {
      [DELETED_PATH]: "upstream edited deleted file\n",
      "ordinary.txt": "upstream batch content\n",
    },
    "Upstream batch",
  );

  const plan = planSync({ cwd: repo.cwd, base, upstream });

  assertFull(repo, plan, base, upstream, [DELETED_PATH]);
  assertPathAbsent(repo, plan.mergeCommit, DELETED_PATH);
  assert.equal(repo.git("show", `${plan.mergeCommit}:ordinary.txt`), "upstream batch content");
});

test("inverse allowlisted conflict rejects fork modification and upstream deletion", (t) => {
  const repo = createRepo(t, { [OWNERSHIP_PATH]: forkDeletedRow(DELETED_PATH) });
  const base = repo.commit("fork", { [DELETED_PATH]: "fork modification\n" }, "Fork modification");
  const upstream = repo.commit("up", { [DELETED_PATH]: null }, "Upstream deletion");

  const plan = planSync({ cwd: repo.cwd, base, upstream });

  assertNone(plan, base, upstream, [
    `conflict on fork-deleted ${DELETED_PATH} is not fork-delete/upstream-modify`,
    `CONFLICT (modify/delete) on ${DELETED_PATH}`,
  ]);
});

test("unlisted fork deletion cannot authorize an upstream modify/delete conflict", (t) => {
  const repo = createRepo(t);
  const base = repo.commit("fork", { [DELETED_PATH]: null }, "Unlisted fork deletion");
  const upstream = repo.commit(
    "up",
    { [DELETED_PATH]: "upstream modification\n" },
    "Upstream modification",
  );

  const plan = planSync({ cwd: repo.cwd, base, upstream });

  assertNone(plan, base, upstream, [
    `conflict on ${DELETED_PATH} (not fork-deleted)`,
    `CONFLICT (modify/delete) on ${DELETED_PATH}`,
  ]);
});

test("allowlisted modify/delete does not hide a separate content conflict", (t) => {
  const repo = createRepo(t, { [OWNERSHIP_PATH]: forkDeletedRow(DELETED_PATH) });
  const base = repo.commit(
    "fork",
    {
      [DELETED_PATH]: null,
      [CONFLICT_PATH]: "fork content\n",
    },
    "Fork deletion and content edit",
  );
  const upstream = repo.commit(
    "up",
    {
      [DELETED_PATH]: "upstream modification\n",
      [CONFLICT_PATH]: "upstream conflicting content\n",
    },
    "Upstream conflicting batch",
  );

  const plan = planSync({ cwd: repo.cwd, base, upstream });

  assertNone(plan, base, upstream, [
    `conflict on ${CONFLICT_PATH} (not fork-deleted)`,
    `CONFLICT (contents) on ${CONFLICT_PATH}`,
  ]);
});

test("upstream ownership edits cannot authorize the same upstream batch", (t) => {
  const repo = createRepo(t);
  const base = repo.commit("fork", { [DELETED_PATH]: null }, "Unlisted fork deletion");
  const upstream = repo.commit(
    "up",
    {
      [OWNERSHIP_PATH]: forkDeletedRow(DELETED_PATH),
      [DELETED_PATH]: "upstream self-authorized modification\n",
    },
    "Upstream ownership and modification",
  );

  const plan = planSync({ cwd: repo.cwd, base, upstream });

  assert.equal(repo.git("show", `${base}:${OWNERSHIP_PATH}`), "");
  assertNone(plan, base, upstream, [
    `conflict on ${DELETED_PATH} (not fork-deleted)`,
    `CONFLICT (modify/delete) on ${DELETED_PATH}`,
  ]);
});

test("new upstream workflow absent from the fork base requires review", (t) => {
  const repo = createRepo(t);
  const base = repo.commit("fork", { "fork.txt": "fork content\n" }, "Fork change");
  const upstream = repo.commit(
    "up",
    {
      ".github/workflows/new.yml": "name: New upstream workflow\n",
    },
    "Upstream workflow addition",
  );

  const plan = planSync({ cwd: repo.cwd, base, upstream });

  assertNone(plan, base, upstream, ["new upstream workflow .github/workflows/new.yml"]);
  assertPathAbsent(repo, base, ".github/workflows/new.yml");
});

test("upstream modification of an existing fork workflow is accepted", (t) => {
  const workflowPath = ".github/workflows/existing.yml";
  const repo = createRepo(t, { [workflowPath]: "name: Existing workflow\n" });
  const base = repo.commit("fork", { "fork.txt": "fork content\n" }, "Fork change");
  const upstream = repo.commit(
    "up",
    {
      [workflowPath]: "name: Updated existing workflow\n",
    },
    "Upstream workflow modification",
  );

  const plan = planSync({ cwd: repo.cwd, base, upstream });

  assertFull(repo, plan, base, upstream);
  assert.equal(
    repo.git("show", `${plan.mergeCommit}:${workflowPath}`),
    "name: Updated existing workflow",
  );
});

test("prefix stops at the first content conflict after clean and allowlisted commits", (t) => {
  const repo = createRepo(t, { [OWNERSHIP_PATH]: forkDeletedRow(DELETED_PATH) });
  const base = repo.commit(
    "fork",
    {
      [DELETED_PATH]: null,
      [CONFLICT_PATH]: "fork content\n",
    },
    "Fork deletion and content edit",
  );
  const c1 = repo.commit("up", { "ordinary.txt": "upstream c1\n" }, "c1 clean");
  const c2 = repo.commit("up", { [DELETED_PATH]: "upstream c2\n" }, "c2 allowlisted modify/delete");
  const c3 = repo.commit("up", { [CONFLICT_PATH]: "upstream c3\n" }, "c3 content conflict");
  const c4 = repo.commit("up", { "tail.txt": "upstream c4\n" }, "c4 tail");

  const plan = planSync({ cwd: repo.cwd, base, upstream: c4 });

  assert.equal(plan.outcome, "prefix");
  assert.equal(plan.base, base);
  assert.equal(plan.upstream, c4);
  assert.equal(plan.target, c2);
  assert.deepEqual(plan.deletedPaths, [DELETED_PATH]);
  assert.deepEqual(plan.blocked, {
    commit: c3,
    reasons: [
      `conflict on ${CONFLICT_PATH} (not fork-deleted)`,
      `CONFLICT (contents) on ${CONFLICT_PATH}`,
    ],
  });
  assertMergeCommit(repo, plan.mergeCommit, base, c2);
  assert.equal(repo.git("merge-base", "--is-ancestor", c1, plan.mergeCommit), "");
  assertPathAbsent(repo, plan.mergeCommit, DELETED_PATH);
  assertPathAbsent(repo, plan.mergeCommit, "tail.txt");
  assert.equal(repo.git("show", `${plan.mergeCommit}:ordinary.txt`), "upstream c1");
  assert.equal(repo.git("show", `${plan.mergeCommit}:${CONFLICT_PATH}`), "fork content");
});

test("first upstream commit conflicting yields none and no merge commit", (t) => {
  const repo = createRepo(t);
  const base = repo.commit("fork", { [CONFLICT_PATH]: "fork content\n" }, "Fork content edit");
  const upstream = repo.commit(
    "up",
    { [CONFLICT_PATH]: "upstream content\n" },
    "First upstream conflict",
  );

  const plan = planSync({ cwd: repo.cwd, base, upstream });

  assertNone(plan, base, upstream, [
    `conflict on ${CONFLICT_PATH} (not fork-deleted)`,
    `CONFLICT (contents) on ${CONFLICT_PATH}`,
  ]);
});

test("upstream already contained in the fork base yields up-to-date", (t) => {
  const repo = createRepo(t);
  const upstream = repo.commit("up", { "ordinary.txt": "upstream content\n" }, "Upstream change");
  repo.git("checkout", "--quiet", "fork");
  repo.git("merge", "--quiet", "--ff-only", "up");
  const base = repo.commit("fork", { "fork.txt": "fork content\n" }, "Fork after upstream");

  const plan = planSync({ cwd: repo.cwd, base, upstream });

  assert.deepEqual(plan, {
    outcome: "up-to-date",
    base,
    upstream,
    target: null,
    mergeCommit: null,
    deletedPaths: [],
    blocked: null,
  });
});

test("allowlisted path containing spaces remains deleted", (t) => {
  const filePath = "docs/a file.md";
  const repo = createRepo(t, {
    [filePath]: "common spaced path content\n",
    [OWNERSHIP_PATH]: forkDeletedRow(filePath),
  });
  const base = repo.commit("fork", { [filePath]: null }, "Fork spaced path deletion");
  const upstream = repo.commit(
    "up",
    {
      [filePath]: "upstream spaced path modification\n",
      "ordinary.txt": "upstream accompanying edit\n",
    },
    "Upstream spaced path modification",
  );

  const plan = planSync({ cwd: repo.cwd, base, upstream });

  assertFull(repo, plan, base, upstream, [filePath]);
  assertPathAbsent(repo, plan.mergeCommit, filePath);
  assert.equal(repo.git("show", `${plan.mergeCommit}:ordinary.txt`), "upstream accompanying edit");
});

test("parseMergeTreeOutput parses a literal NUL fixture with two conflicts and messages", () => {
  const tree = "a".repeat(40);
  const ancestor = "b".repeat(40);
  const ours = "c".repeat(40);
  const theirs = "d".repeat(40);
  const fixture = [
    tree,
    `100644 ${ancestor} 1\tdocs/a file.md`,
    `100644 ${theirs} 3\tdocs/a file.md`,
    `100644 ${ancestor} 1\tcontent.txt`,
    `100644 ${ours} 2\tcontent.txt`,
    `100644 ${theirs} 3\tcontent.txt`,
    "",
    "1",
    "docs/a file.md",
    "CONFLICT (modify/delete)",
    "Fork deleted docs/a file.md; upstream modified it.\n",
    "1",
    "content.txt",
    "Auto-merging",
    "Auto-merging content.txt\n",
    "2",
    "content.txt",
    "docs/a file.md",
    "CONFLICT (contents)",
    "Two-path conflict message.\n",
    "",
  ].join("\0");

  assert.deepEqual(parseMergeTreeOutput(fixture), {
    tree,
    entries: [
      { mode: "100644", oid: ancestor, stage: 1, path: "docs/a file.md" },
      { mode: "100644", oid: theirs, stage: 3, path: "docs/a file.md" },
      { mode: "100644", oid: ancestor, stage: 1, path: "content.txt" },
      { mode: "100644", oid: ours, stage: 2, path: "content.txt" },
      { mode: "100644", oid: theirs, stage: 3, path: "content.txt" },
    ],
    messages: [
      {
        paths: ["docs/a file.md"],
        type: "CONFLICT (modify/delete)",
        message: "Fork deleted docs/a file.md; upstream modified it.\n",
      },
      { paths: ["content.txt"], type: "Auto-merging", message: "Auto-merging content.txt\n" },
      {
        paths: ["content.txt", "docs/a file.md"],
        type: "CONFLICT (contents)",
        message: "Two-path conflict message.\n",
      },
    ],
  });
});

test("CLI prints exactly one JSON plan line from a temporary repository", (t) => {
  const repo = createRepo(t);
  const base = repo.commit("fork", { "fork.txt": "fork content\n" }, "Fork change");
  const upstream = repo.commit(
    "up",
    { "ordinary.txt": "upstream CLI content\n" },
    "Upstream change",
  );
  const expected = planSync({ cwd: repo.cwd, base, upstream });

  const result = spawnSync(process.execPath, [CLI_PATH, "--base", base, "--upstream", upstream], {
    cwd: repo.cwd,
    encoding: "utf8",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^\{[^\n]+\}\n$/u);
  const plan = JSON.parse(result.stdout);
  assertFull(repo, plan, base, upstream);
  assert.deepEqual({ ...plan, mergeCommit: null }, { ...expected, mergeCommit: null });
  assert.equal(
    repo.git("rev-parse", `${plan.mergeCommit}^{tree}`),
    repo.git("rev-parse", `${expected.mergeCommit}^{tree}`),
  );
  assert.equal(repo.git("show", `${plan.mergeCommit}:ordinary.txt`), "upstream CLI content");
});
