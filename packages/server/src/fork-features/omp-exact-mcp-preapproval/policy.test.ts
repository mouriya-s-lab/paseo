import { describe, expect, test } from "vitest";
import type { ToolPolicy } from "@getpaseo/protocol/agent-types";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { buildProviderRegistry } from "../../server/agent/provider-registry.js";
import { ToolPolicyUnsupportedError } from "../../server/agent/provider-options.js";
import { OmpHarness } from "../../server/agent/providers/omp/test-utils/omp-harness.js";

const HUB_POLICY: ToolPolicy = {
  preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }],
};

describe("OMP exact MCP preapproval", () => {
  test("the registry accepts a Hub tool policy for omp", () => {
    const registry = buildProviderRegistry(createTestLogger(), {});
    const config = { provider: "omp", cwd: "/tmp/paseo-omp-agent-test", modeId: "full" };

    expect(registry.omp.supportsExactMcpPreapproval).toBe(true);
    expect(registry.omp.applyToolPolicy(config, HUB_POLICY)).toEqual({
      ...config,
      toolPolicy: HUB_POLICY,
    });
  });

  test("full mode launches yolo with the tool policy", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "full", toolPolicy: HUB_POLICY });

    expect(omp.launchConfiguration().argv).toEqual(
      expect.arrayContaining(["--approval-mode", "yolo"]),
    );
    await omp.close();
  });

  test("an omitted mode resolves to full and is accepted", async () => {
    const omp = new OmpHarness();
    await omp.start({ toolPolicy: HUB_POLICY });

    expect(omp.launchConfiguration().modeId).toBe("full");
    await omp.close();
  });

  test.each(["ask", "write"])(
    "mode %s with a tool policy is rejected before launch",
    async (modeId) => {
      const omp = new OmpHarness();

      await expect(omp.start({ modeId, toolPolicy: HUB_POLICY })).rejects.toBeInstanceOf(
        ToolPolicyUnsupportedError,
      );
      expect(() => omp.launchConfiguration()).toThrow("OMP harness has not launched");
    },
  );

  test("a running preapproved session cannot leave full mode", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "full", toolPolicy: HUB_POLICY });

    await expect(omp.setMode("ask")).rejects.toBeInstanceOf(ToolPolicyUnsupportedError);
    await expect(omp.currentMode()).resolves.toBe("full");
    await omp.close();
  });

  test("sessions without a tool policy keep every mode", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask" });

    expect(omp.launchConfiguration().modeId).toBe("ask");
    await omp.close();
  });
});
