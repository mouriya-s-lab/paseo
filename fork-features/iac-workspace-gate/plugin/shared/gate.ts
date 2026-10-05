import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Blockers of the github-agent-router pre-dispatch gate, in check order. The CLI
// (`paseo iac-gate`) maps each to the exit code the router already understands.
export const GATE_BLOCKERS = [
  "lock-held",
  "git-error",
  "not-default-branch",
  "not-at-remote-tip",
  "dirty-tracked",
  "submodule-unclean",
] as const;

export const GateVerdictSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("clean"), branch: z.string(), head: z.string() }),
  z.object({ verdict: z.enum(GATE_BLOCKERS), detail: z.string() }),
]);

export type GateVerdict = z.infer<typeof GateVerdictSchema>;

export const workspaceGateRpc = defineRpc({
  name: "workspace.gate",
  input: z.object({ cwd: z.string().min(1) }),
  output: GateVerdictSchema,
});
