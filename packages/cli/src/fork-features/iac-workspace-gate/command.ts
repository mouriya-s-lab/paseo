import { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import { connectToDaemon } from "../../utils/client.js";
import { addDaemonHostOption, withGlobalOptions } from "../../utils/command-options.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";

// `paseo iac-gate <cwd>`: github-agent-router's pre-dispatch gate. The checks run in
// the daemon's `iac-workspace-gate` plugin (fork-features/iac-workspace-gate/plugin),
// which can read the checkout volume an sshd session cannot (mouriya-s-lab/paseo#40).
const PLUGIN_ID = "iac-workspace-gate";
const RPC_METHOD = "workspace.gate";

// Wire shape of the plugin's `workspace.gate` output, parsed at this boundary.
const GateVerdictSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("clean"), branch: z.string(), head: z.string() }),
  z.object({
    verdict: z.enum([
      "lock-held",
      "git-error",
      "not-default-branch",
      "not-at-remote-tip",
      "dirty-tracked",
      "submodule-unclean",
    ]),
    detail: z.string(),
  }),
]);

export type GateVerdict = z.infer<typeof GateVerdictSchema>;

export type GateOutcome =
  | Readonly<{ tag: "verdict"; verdict: GateVerdict }>
  | Readonly<{ tag: "unavailable"; detail: string }>;

// The router's exit-code contract; 16/17 are its daemon-unreachable and
// hub-not-connected codes, so an unavailable gate takes 18.
export function gateExit(outcome: GateOutcome): { code: number; line: string } {
  if (outcome.tag === "unavailable")
    return { code: 18, line: `gate-unavailable: ${outcome.detail}` };
  const verdict = outcome.verdict;
  switch (verdict.verdict) {
    case "clean":
      return { code: 0, line: `clean ${verdict.branch} ${verdict.head}` };
    case "lock-held":
      return { code: 10, line: `lock-held: ${verdict.detail}` };
    case "git-error":
      return { code: 11, line: `git-error: ${verdict.detail}` };
    case "not-default-branch":
      return { code: 12, line: `not-default-branch: ${verdict.detail}` };
    case "not-at-remote-tip":
      return { code: 13, line: `not-at-remote-tip: ${verdict.detail}` };
    case "dirty-tracked":
      return { code: 14, line: `dirty-tracked: ${verdict.detail}` };
    case "submodule-unclean":
      return { code: 15, line: `submodule-unclean: ${verdict.detail}` };
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}

async function runGate(cwd: string, target: DaemonTarget): Promise<GateOutcome> {
  let client: DaemonClient;
  try {
    client = await connectToDaemon({ target });
  } catch (error) {
    return { tag: "unavailable", detail: describe(error) };
  }
  try {
    const parsed = GateVerdictSchema.safeParse(
      await client.invokePluginRpc(PLUGIN_ID, RPC_METHOD, { cwd }),
    );
    if (!parsed.success)
      return { tag: "unavailable", detail: `unexpected plugin output: ${parsed.error.message}` };
    return { tag: "verdict", verdict: parsed.data };
  } catch (error) {
    return { tag: "unavailable", detail: describe(error) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function describe(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

export function createIacGateCommand(): Command {
  return addDaemonHostOption(
    new Command("iac-gate")
      .description(
        "Check an IaC checkout is ready for an agent dispatch (github-agent-router gate)",
      )
      .argument("<cwd>", "Absolute path of the checkout the agent works in"),
  ).action(
    withGlobalOptions(
      async (cwd: string, options: { daemonTarget: DaemonTarget }, _command: Command) => {
        const { code, line } = gateExit(await runGate(cwd, options.daemonTarget));
        process.stdout.write(`${line}\n`);
        process.exitCode = code;
      },
    ),
  );
}
