import { describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import type { HostProfile } from "@/types/host-connection";
import {
  parseSelfHostedManifest,
  readSelfHostedLocalDaemonOverride,
  reconcileSelfHostedHostProfiles,
} from "./runtime";

function makeProfile(): HostProfile {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    serverId: "server-1",
    label: "Old label",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections: [
      {
        id: "selfhosted:alpha",
        type: "directTcp",
        endpoint: "old.example:6767",
        useTls: false,
        basePath: "/daemons/alpha",
      },
      {
        id: "direct:legacy.example:6767",
        type: "directTcp",
        endpoint: "legacy.example:6767",
        useTls: false,
      },
    ],
    preferredConnectionId: "selfhosted:alpha",
    createdAt: now,
    updatedAt: now,
  };
}

describe("self-hosted runtime fork", () => {
  it("gives URL tcp overrides precedence over the configured endpoint", () => {
    expect(
      readSelfHostedLocalDaemonOverride({
        envValue: " configured.example:6767 ",
        location: { hash: "#tcp=override.example:7777", host: "ui.example:443" },
      }),
    ).toBe("override.example:7777");
    expect(
      readSelfHostedLocalDaemonOverride({
        envValue: "configured.example:6767",
        location: { hash: "#route&tcp=override.example:7777", host: "ui.example:443" },
      }),
    ).toBe("override.example:7777");
  });

  it("trims configured endpoints and maps self-hosted to the browser host", () => {
    expect(
      readSelfHostedLocalDaemonOverride({
        envValue: "  configured.example:6767  ",
        location: { hash: "", host: "ui.example:443" },
      }),
    ).toBe("configured.example:6767");
    expect(
      readSelfHostedLocalDaemonOverride({
        envValue: "self-hosted",
        location: { hash: "", host: "ui.example:443" },
      }),
    ).toBe("ui.example:443");
  });

  it("rejects malformed manifest entries and accepts structurally valid entries", () => {
    expect(
      parseSelfHostedManifest([{ id: "alpha", label: "Alpha", basePath: "/daemons/alpha" }]),
    ).toEqual([{ id: "alpha", label: "Alpha", basePath: "/daemons/alpha" }]);
    expect(() =>
      parseSelfHostedManifest([{ id: "Alpha", label: "Alpha", basePath: "/daemons/Alpha" }]),
    ).toThrow();
    expect(() =>
      parseSelfHostedManifest([{ id: "alpha", label: "Alpha", basePath: "/daemons/other" }]),
    ).toThrow();
  });

  it("reconciles managed connections while preserving ordinary connections", () => {
    const [profile] = reconcileSelfHostedHostProfiles({
      profiles: [makeProfile()],
      manifest: [{ id: "alpha", label: "Alpha", basePath: "/daemons/alpha" }],
      endpoint: "ui.example:443",
      useTls: true,
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(profile).toMatchObject({
      serverId: "server-1",
      label: "Alpha",
      preferredConnectionId: "selfhosted:alpha",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(profile?.connections).toEqual([
      {
        id: "selfhosted:alpha",
        type: "directTcp",
        endpoint: "ui.example:443",
        useTls: true,
        basePath: "/daemons/alpha",
      },
      {
        id: "direct:legacy.example:6767",
        type: "directTcp",
        endpoint: "legacy.example:6767",
        useTls: false,
      },
    ]);
  });
});
