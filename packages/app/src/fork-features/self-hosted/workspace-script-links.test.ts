import { describe, expect, it } from "vitest";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { resolveWorkspaceScriptLink } from "@/utils/workspace-script-links";

const runningService: WorkspaceScriptPayload = {
  scriptName: "web",
  type: "service",
  hostname: "web--feature--paseo.localhost",
  port: 3000,
  localProxyUrl: null,
  publicProxyUrl: null,
  proxyUrl: null,
  lifecycle: "running",
  health: "healthy",
  exitCode: null,
  terminalId: null,
};

describe("workspace script links through a proxied daemon", () => {
  it("does not invent a direct service route for a proxied daemon", () => {
    expect(
      resolveWorkspaceScriptLink({
        script: runningService,
        activeConnection: {
          type: "directTcp",
          endpoint: "paseo.example.com:443",
          display: "paseo.example.com:443",
          useTls: true,
          basePath: "/daemons/alpha",
        },
      }),
    ).toEqual({ primary: null, targets: [] });
  });
});
