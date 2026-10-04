import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { defaultHostAppearance } from "@/hosts/appearance";
import { HostRuntimeController, type HostRuntimeControllerDeps } from "@/runtime/host-runtime";
import type { HostConnection, HostProfile } from "@/types/host-connection";

const managedConnection: HostConnection = {
  id: "selfhosted:alpha",
  type: "directTcp",
  endpoint: "proxy.example:443",
  useTls: true,
  basePath: "/daemons/alpha",
};
const manualConnection: HostConnection = {
  id: "direct:host:1234",
  type: "directTcp",
  endpoint: "host:1234",
};

class FakeDaemonClient {
  private state: ConnectionState = { status: "idle" };
  private listeners = new Set<(state: ConnectionState) => void>();
  readonly lastError = null;
  readonly measureLatency = vi.fn(async () => 5);
  readonly getLastLivenessRttMs = vi.fn(() => 5);
  readonly setReconnectEnabled = vi.fn<(enabled: boolean) => void>();

  async connect(): Promise<void> {
    this.setConnectionState({ status: "connected" });
  }

  async close(): Promise<void> {
    this.setConnectionState({ status: "disconnected", reason: "client_closed" });
  }

  subscribeConnectionStatus(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setConnectionState(state: ConnectionState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function makeHarness() {
  const host: HostProfile = {
    serverId: "srv_projection",
    label: "Alpha",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections: [managedConnection, manualConnection],
    preferredConnectionId: manualConnection.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const createdClients: FakeDaemonClient[] = [];
  const createClient = vi.fn<HostRuntimeControllerDeps["createClient"]>(() => {
    const client = new FakeDaemonClient();
    createdClients.push(client);
    return client as unknown as DaemonClient;
  });
  const connectToDaemon = vi.fn<HostRuntimeControllerDeps["connectToDaemon"]>(
    async ({ host: probeHost }) => {
      const client = new FakeDaemonClient();
      await client.connect();
      return {
        client: client as unknown as DaemonClient,
        serverId: probeHost.serverId,
        hostname: probeHost.label ?? null,
      };
    },
  );
  const controller = new HostRuntimeController({
    host,
    deps: { createClient, connectToDaemon, getClientId: async () => "cid_projection" },
  });
  return { controller, host, createClient, connectToDaemon, createdClients };
}

function useHostRuntimeClock(): void {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("HostRuntimeController self-hosted connection projection", () => {
  it("probes and activates only managed connections when self-hosting is enabled", async () => {
    vi.stubEnv("EXPO_PUBLIC_PASEO_SELFHOSTED", "true");
    useHostRuntimeClock();
    const { controller, host, createClient, connectToDaemon, createdClients } = makeHarness();

    try {
      await controller.start();

      expect(connectToDaemon.mock.calls.map(([input]) => input.connection)).toEqual([
        managedConnection,
      ]);
      expect(controller.getSnapshot()).toMatchObject({
        activeConnectionId: managedConnection.id,
        connectionStatus: "online",
        activeConnection: { type: "directTcp", basePath: "/daemons/alpha" },
      });
      expect(controller.getSnapshot().probeByConnectionId).toEqual(
        new Map([[managedConnection.id, { status: "available", latencyMs: 5 }]]),
      );

      // Startup adopts its probe client; explicitly activating exercises createClient too.
      await controller.activateConnection({ connectionId: managedConnection.id });
      expect(createClient.mock.calls.map(([input]) => input.connection)).toEqual([
        managedConnection,
      ]);
      const activeClient = createdClients[0]!;
      expect(controller.getSnapshot().client).toBe(activeClient);

      await controller.activateConnection({ connectionId: manualConnection.id });
      expect(createClient).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().activeConnectionId).toBe(managedConnection.id);
      expect(controller.getSnapshot().client).toBe(activeClient);

      // Each interval is long enough that an unfiltered inactive connection would be probed.
      for (let interval = 0; interval < 3; interval += 1) {
        const previousLivenessChecks = activeClient.getLastLivenessRttMs.mock.calls.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(activeClient.getLastLivenessRttMs.mock.calls.length).toBeGreaterThan(
          previousLivenessChecks,
        );
        expect(controller.getSnapshot().activeConnectionId).toBe(managedConnection.id);
        expect(controller.getSnapshot().connectionStatus).toBe("online");
        expect(controller.getSnapshot().probeByConnectionId).toEqual(
          new Map([[managedConnection.id, { status: "available", latencyMs: 5 }]]),
        );
        expect(connectToDaemon.mock.calls.map(([input]) => input.connection)).toEqual([
          managedConnection,
        ]);
        expect(createClient.mock.calls.map(([input]) => input.connection)).toEqual([
          managedConnection,
        ]);
      }

      expect(connectToDaemon.mock.calls[0]![0].host.connections).toEqual([managedConnection]);
      expect(createClient.mock.calls[0]![0].host.connections).toEqual([managedConnection]);
      expect(host.connections).toEqual([managedConnection, manualConnection]);
    } finally {
      await controller.stop();
    }
  });

  it("preserves probing of managed and manual connections when self-hosting is disabled", async () => {
    vi.stubEnv("EXPO_PUBLIC_PASEO_SELFHOSTED", "false");
    useHostRuntimeClock();
    const { controller, host, createClient, connectToDaemon, createdClients } = makeHarness();

    try {
      await controller.start();

      expect(connectToDaemon.mock.calls.map(([input]) => input.connection)).toEqual([
        managedConnection,
        manualConnection,
      ]);
      const expectedProbes = new Map([
        [managedConnection.id, { status: "available", latencyMs: 5 }],
        [manualConnection.id, { status: "available", latencyMs: 5 }],
      ]);
      expect(controller.getSnapshot().probeByConnectionId).toEqual(expectedProbes);

      // Fix the active connection so periodic manual probes do not depend on startup ordering.
      await controller.activateConnection({ connectionId: managedConnection.id });
      const activeClient = createdClients[0]!;
      expect(controller.getSnapshot().client).toBe(activeClient);
      expect(createClient.mock.calls[0]![0].host).toBe(host);

      for (let interval = 0; interval < 3; interval += 1) {
        const previousLivenessChecks = activeClient.getLastLivenessRttMs.mock.calls.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(activeClient.getLastLivenessRttMs.mock.calls.length).toBeGreaterThan(
          previousLivenessChecks,
        );
        expect(
          connectToDaemon.mock.calls.filter(
            ([input]) => input.connection.id === manualConnection.id,
          ),
        ).toHaveLength(interval + 2);
        expect(controller.getSnapshot().probeByConnectionId).toEqual(expectedProbes);
        expect(controller.getSnapshot().connectionStatus).toBe("online");
      }

      expect(connectToDaemon.mock.calls.map(([input]) => input.connection)).toEqual([
        managedConnection,
        manualConnection,
        manualConnection,
        manualConnection,
        manualConnection,
      ]);
      expect(connectToDaemon.mock.calls.map(([input]) => input.host)).toEqual([
        host,
        host,
        host,
        host,
        host,
      ]);
    } finally {
      await controller.stop();
    }
  });
});
