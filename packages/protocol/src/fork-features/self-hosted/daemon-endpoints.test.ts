import { describe, expect, test } from "vitest";
import { buildDaemonWebSocketUrl } from "../../daemon-endpoints";

describe("daemon websocket URLs behind the self-hosted proxy", () => {
  test("includes a validated proxy base path", () => {
    expect(
      buildDaemonWebSocketUrl("example.com:443", {
        useTls: true,
        basePath: "/daemons/alpha",
      }),
    ).toBe("wss://example.com/daemons/alpha/ws");
    expect(() =>
      buildDaemonWebSocketUrl("example.com:443", {
        useTls: true,
        basePath: "/daemons/Alpha",
      }),
    ).toThrow("Invalid proxy base path");
  });
});
