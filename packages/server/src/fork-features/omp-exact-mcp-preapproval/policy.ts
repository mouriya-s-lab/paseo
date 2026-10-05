import type { ToolPolicy } from "@getpaseo/protocol/agent-types";

import { ToolPolicyUnsupportedError } from "../../server/agent/provider-options.js";

// OMP bridges each injected MCP tool as an RPC host tool. OMP's approval gate gives host
// tools the `exec` tier, so `write` and `ask` would prompt for a Hub-preapproved tool and
// stall an unattended run. Only `full` (`--approval-mode yolo`) runs every tool without a
// prompt, which is the one mode where an exact preapproval grant is actually honoured.
export const OMP_PREAPPROVAL_MODE_ID = "full";

export function assertOmpToolPolicyMode(modeId: string, toolPolicy: ToolPolicy | undefined): void {
  if (!toolPolicy || modeId === OMP_PREAPPROVAL_MODE_ID) return;
  throw new ToolPolicyUnsupportedError(
    "omp",
    `Provider 'omp' honours exact MCP preapproval only in mode '${OMP_PREAPPROVAL_MODE_ID}'; mode '${modeId}' would prompt for preapproved tools`,
  );
}
