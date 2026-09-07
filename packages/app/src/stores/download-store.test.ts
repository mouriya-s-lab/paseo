import { describe, expect, it } from "vitest";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import { resolveDaemonDownloadTarget } from "./download-store";

function makeProfile(connections: HostConnection[]): HostProfile {
  return {
    serverId: "srv_download",
    label: "Download host",
    appearance: { color: "none", badgeDisplay: null },
    lifecycle: {},
    connections,
    preferredConnectionId: connections[0]?.id ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function directTcp(
  id: string,
  endpoint: string,
  options: Pick<Extract<HostConnection, { type: "directTcp" }>, "basePath" | "useTls"> = {},
): HostConnection {
  return {
    id,
    type: "directTcp",
    endpoint,
    useTls: options.useTls ?? false,
    ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
  };
}

describe("resolveDaemonDownloadTarget", () => {
  it("binds the download URL to the active managed connection", () => {
    const first = directTcp("selfhosted:alpha", "proxy.example.com:443", {
      basePath: "/daemons/alpha",
      useTls: true,
    });
    const active = directTcp("selfhosted:beta", "proxy.example.com:443", {
      basePath: "/daemons/beta",
      useTls: true,
    });

    expect(resolveDaemonDownloadTarget(makeProfile([first, active]), active.id)).toMatchObject({
      baseUrl: "https://proxy.example.com/daemons/beta/",
      authHeader: null,
      authCredentials: null,
    });
  });

  it("keeps the direct HTTP fallback for a non-direct active session", () => {
    const direct = directTcp("direct:host:6767", "host.example.com:6767");
    const relay: HostConnection = {
      id: "relay:relay.example.com:443",
      type: "relay",
      relayEndpoint: "relay.example.com:443",
      daemonPublicKeyB64: "public-key",
    };

    expect(resolveDaemonDownloadTarget(makeProfile([direct, relay]), relay.id).baseUrl).toBe(
      "http://host.example.com:6767/",
    );
  });
});
