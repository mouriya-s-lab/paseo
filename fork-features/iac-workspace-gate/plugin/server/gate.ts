import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { GateVerdict, workspaceGateRpc } from "../shared/gate";

// The plugin RPC itself times out after 30 s; fetch gets most of that budget.
const GIT_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 18_000;
// The system git, as the former SSH gate resolved it. The daemon's login-shell PATH
// puts Homebrew first, and Homebrew binaries hang on the operator's Mac.
const GIT = "/Library/Developer/CommandLineTools/usr/bin/git";

type Git = { ok: true; out: string } | { ok: false; error: string };

function git(cwd: string, args: readonly string[], timeout = GIT_TIMEOUT_MS): Promise<Git> {
  const { promise, resolve } = Promise.withResolvers<Git>();
  execFile(
    GIT,
    ["-C", cwd, ...args],
    { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    (error, stdout, stderr) => {
      if (error)
        resolve({ ok: false, error: `git ${args.join(" ")}: ${(stderr || error.message).trim()}` });
      else resolve({ ok: true, out: stdout.trim() });
    },
  );
  return promise;
}

const gitError = (detail: string): GateVerdict => ({ verdict: "git-error", detail });

// Same checks, order, and blockers as the router's former SSH gate script. It runs
// here because the daemon holds the macOS file access to the checkout volume that
// an sshd session no longer gets (mouriya-s-lab/paseo#40). Read-only except the
// default-branch fetch the remote-tip comparison needs.
export async function checkWorkspace({
  cwd,
}: RpcInput<typeof workspaceGateRpc>): Promise<GateVerdict> {
  if (!isAbsolute(cwd)) return gitError(`not an absolute path: ${cwd}`);
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch (error) {
    return gitError(
      `unreadable checkout: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return gitError(top.error);
  if (realpathSync(top.out) !== root)
    return gitError(`not a checkout root: ${cwd} is inside ${top.out}`);

  const lock = join(root, ".iac-agent.lock");
  if (existsSync(lock)) return { verdict: "lock-held", detail: lock };

  const originHead = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (!originHead.ok) return gitError("origin/HEAD unresolved");
  const defaultBranch = originHead.out.replace(/^origin\//, "");

  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok) return gitError(branch.error);
  if (branch.out !== defaultBranch)
    return { verdict: "not-default-branch", detail: `${branch.out} != ${defaultBranch}` };

  const fetch = await git(root, ["fetch", "--quiet", "origin", defaultBranch], FETCH_TIMEOUT_MS);
  if (!fetch.ok) return gitError(`fetch failed: ${fetch.error}`);
  const local = await git(root, ["rev-parse", "HEAD"]);
  const remote = await git(root, ["rev-parse", `origin/${defaultBranch}`]);
  if (!local.ok) return gitError(local.error);
  if (!remote.ok) return gitError(remote.error);
  if (local.out !== remote.out)
    return {
      verdict: "not-at-remote-tip",
      detail: `${local.out} != origin/${defaultBranch} ${remote.out}`,
    };

  const porcelain = await git(root, ["status", "--porcelain", "--untracked-files=no"]);
  if (!porcelain.ok) return gitError(porcelain.error);
  if (porcelain.out !== "")
    return { verdict: "dirty-tracked", detail: porcelain.out.split("\n").slice(0, 5).join("; ") };

  const submodules = await git(root, ["submodule", "status"]);
  if (!submodules.ok) return gitError(submodules.error);
  const unclean = submodules.out.split("\n").filter((line) => /^[-+U]/.test(line));
  if (unclean.length > 0)
    return { verdict: "submodule-unclean", detail: unclean.slice(0, 5).join("; ") };

  return { verdict: "clean", branch: defaultBranch, head: local.out };
}
