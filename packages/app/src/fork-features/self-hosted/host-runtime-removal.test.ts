import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { defaultHostAppearance } from "@/hosts/appearance";
import { HostRuntimeController, type HostRuntimeControllerDeps } from "@/runtime/host-runtime";
import type { HostConnection, HostProfile } from "@/types/host-connection";

class FakeDaemonClient {
  private state: ConnectionState = { status: "idle" };
  private listeners = new Set<(state: ConnectionState) => void>();
  readonly lastError = null;

  constructor(private readonly latencyMs: number) {}

  readonly connect = vi.fn(async () => {
    this.setConnectionState({ status: "connected" });
  });

  readonly close = vi.fn(async () => {
    this.setConnectionState({ status: "disconnected", reason: "client_closed" });
  });

  readonly measureLatency = vi.fn(async () => this.latencyMs);
  readonly getLastLivenessRttMs = vi.fn(() => this.latencyMs);
  readonly setReconnectEnabled = vi.fn((_enabled: boolean) => {});

  getConnectionState(): ConnectionState {
    return this.state;
  }

  subscribeConnectionStatus(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setConnectionState(state: ConnectionState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function makeHost(connections: HostConnection[]): HostProfile {
  return {
    serverId: "srv_removal",
    label: "Removal test host",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: connections[0]?.id ?? null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function makeDeps(latencyByConnectionId: Record<string, number>) {
  const createdClients: Array<{ connectionId: string; client: FakeDaemonClient }> = [];
  const probeAttempts: string[] = [];
  const makeClient = (connection: HostConnection): FakeDaemonClient => {
    const latencyMs = latencyByConnectionId[connection.id];
    if (latencyMs === undefined) throw new Error(`missing latency for ${connection.id}`);
    const client = new FakeDaemonClient(latencyMs);
    createdClients.push({ connectionId: connection.id, client });
    return client;
  };
  const deps: HostRuntimeControllerDeps = {
    createClient: ({ connection }) => makeClient(connection) as unknown as DaemonClient,
    connectToDaemon: async ({ host, connection }) => {
      probeAttempts.push(connection.id);
      const client = makeClient(connection);
      await client.connect();
      return {
        client: client as unknown as DaemonClient,
        serverId: host.serverId,
        hostname: host.label,
      };
    },
    getClientId: async () => "cid_removal",
  };
  return { deps, createdClients, probeAttempts };
}

const controllers: HostRuntimeController[] = [];

afterEach(async () => {
  try {
    for (const controller of controllers) await controller.stop();
  } finally {
    controllers.length = 0;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

function createController(
  host: HostProfile,
  deps: HostRuntimeControllerDeps,
): HostRuntimeController {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
  const controller = new HostRuntimeController({ host, deps });
  controllers.push(controller);
  return controller;
}

const managed: HostConnection = {
  id: "selfhosted:alpha",
  type: "directTcp",
  endpoint: "ui.example:443",
  basePath: "/daemons/alpha",
  useTls: true,
};

const manual: HostConnection = {
  id: "direct:manual.example:6767",
  type: "directTcp",
  endpoint: "manual.example:6767",
};

describe("host runtime connection removal", () => {
  it("closes a removed managed client without falling back to a stored manual connection", async () => {
    vi.stubEnv("EXPO_PUBLIC_PASEO_SELFHOSTED", "true");
    const harness = makeDeps({ [managed.id]: 5, [manual.id]: 20 });
    const controller = createController(makeHost([managed, manual]), harness.deps);
    await controller.start();
    await controller.activateConnection({ connectionId: managed.id });
    const activeClient = harness.createdClients.at(-1)!.client;
    expect(controller.getSnapshot()).toMatchObject({
      connectionStatus: "online",
      activeConnectionId: managed.id,
      client: activeClient,
    });
    expect(activeClient.connect).toHaveBeenCalledOnce();
    const clientsBeforeRemoval = harness.createdClients.length;
    const probesBeforeRemoval = harness.probeAttempts.length;

    await controller.updateHost(makeHost([manual]));

    expect(activeClient.close).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ activeConnectionId: null, client: null });
    expect(controller.getSnapshot().probeByConnectionId.size).toBe(0);
    // The running controller ticks every 2s; 60s also spans several 10s steady intervals.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.getSnapshot()).toMatchObject({ activeConnectionId: null, client: null });
    expect(controller.getSnapshot().probeByConnectionId.size).toBe(0);
    expect(activeClient.close).toHaveBeenCalledOnce();
    expect(harness.createdClients).toHaveLength(clientsBeforeRemoval);
    expect(harness.probeAttempts).toHaveLength(probesBeforeRemoval);
    expect(harness.createdClients.map(({ connectionId }) => connectionId)).not.toContain(manual.id);
  });

  it("stays probe-free with zero managed connections and reconnects after re-adding one", async () => {
    vi.stubEnv("EXPO_PUBLIC_PASEO_SELFHOSTED", "true");
    const harness = makeDeps({ [managed.id]: 5 });
    const controller = createController(makeHost([managed]), harness.deps);
    await controller.start();
    const firstClient = harness.createdClients[0]!.client;
    expect(controller.getSnapshot()).toMatchObject({
      connectionStatus: "online",
      activeConnectionId: managed.id,
      client: firstClient,
    });
    expect(harness.probeAttempts).toEqual([managed.id]);
    expect(firstClient.connect).toHaveBeenCalledOnce();
    expect(firstClient.measureLatency).toHaveBeenCalledOnce();

    await controller.updateHost(makeHost([]));

    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ activeConnectionId: null, client: null });
    expect(controller.getSnapshot().probeByConnectionId.size).toBe(0);
    const measurementsAtRemoval = firstClient.measureLatency.mock.calls.length;
    const livenessReadsAtRemoval = firstClient.getLastLivenessRttMs.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.getSnapshot()).toMatchObject({ activeConnectionId: null, client: null });
    expect(controller.getSnapshot().probeByConnectionId.size).toBe(0);
    expect(harness.probeAttempts).toEqual([managed.id]);
    expect(harness.createdClients).toHaveLength(1);
    expect(firstClient.measureLatency).toHaveBeenCalledTimes(measurementsAtRemoval);
    expect(firstClient.getLastLivenessRttMs).toHaveBeenCalledTimes(livenessReadsAtRemoval);

    await controller.updateHost(makeHost([managed]));

    expect(harness.probeAttempts).toEqual([managed.id, managed.id]);
    expect(harness.createdClients).toHaveLength(2);
    const secondClient = harness.createdClients[1]!.client;
    expect(secondClient).not.toBe(firstClient);
    expect(secondClient.connect).toHaveBeenCalledOnce();
    expect(secondClient.measureLatency).toHaveBeenCalledOnce();
    expect(secondClient.close).not.toHaveBeenCalled();
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      connectionStatus: "online",
      activeConnectionId: managed.id,
      client: secondClient,
    });
    expect(Array.from(controller.getSnapshot().probeByConnectionId.keys())).toEqual([managed.id]);
  });

  it("closes removed connection A and switches to connection B outside self-hosted mode", async () => {
    vi.stubEnv("EXPO_PUBLIC_PASEO_SELFHOSTED", "false");
    const connectionA: HostConnection = { id: "direct:a", type: "directTcp", endpoint: "a:6767" };
    const connectionB: HostConnection = { id: "direct:b", type: "directTcp", endpoint: "b:6767" };
    const harness = makeDeps({ [connectionA.id]: 5, [connectionB.id]: 20 });
    const controller = createController(makeHost([connectionA, connectionB]), harness.deps);
    await controller.start();
    await controller.activateConnection({ connectionId: connectionA.id });
    const clientA = harness.createdClients.at(-1)!.client;
    expect(controller.getSnapshot()).toMatchObject({
      connectionStatus: "online",
      activeConnectionId: connectionA.id,
      client: clientA,
    });
    expect(clientA.connect).toHaveBeenCalledOnce();

    await controller.updateHost(makeHost([connectionB]));

    expect(clientA.close).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().probeByConnectionId.has(connectionA.id)).toBe(false);
    const attemptsAtRemoval = harness.probeAttempts.length;
    const clientsAtRemoval = harness.createdClients.length;
    // B was just probed; allow the normal timer cycle to probe and activate it again.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.probeAttempts.slice(attemptsAtRemoval)).toEqual([connectionB.id]);
    const clientsAfterRemoval = harness.createdClients.slice(clientsAtRemoval);
    expect(clientsAfterRemoval.map(({ connectionId }) => connectionId)).not.toContain(
      connectionA.id,
    );
    const clientB = harness.createdClients.at(-1)!.client;
    expect(harness.createdClients.at(-1)!.connectionId).toBe(connectionB.id);
    expect(clientB.close).not.toHaveBeenCalled();
    expect(clientA.close).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      connectionStatus: "online",
      activeConnectionId: connectionB.id,
      client: clientB,
    });
    expect(Array.from(controller.getSnapshot().probeByConnectionId.keys())).toEqual([
      connectionB.id,
    ]);
  });

  it("discards a successful in-flight probe for a connection removed before it resolves", async () => {
    vi.stubEnv("EXPO_PUBLIC_PASEO_SELFHOSTED", "false");
    const connectionA: HostConnection = { id: "direct:a", type: "directTcp", endpoint: "a:6767" };
    const connectionB: HostConnection = { id: "direct:b", type: "directTcp", endpoint: "b:6767" };
    const harness = makeDeps({ [connectionA.id]: 5, [connectionB.id]: 20 });
    let resolveProbeA!: () => void;
    const probeADeferred = new Promise<void>((resolve) => {
      resolveProbeA = resolve;
    });
    const connectToDaemon = harness.deps.connectToDaemon;
    harness.deps.connectToDaemon = async (input) => {
      if (input.connection.id === connectionB.id) {
        harness.probeAttempts.push(connectionB.id);
        throw new Error("connection B is unavailable");
      }
      const result = await connectToDaemon(input);
      await probeADeferred;
      return result;
    };
    const controller = createController(makeHost([connectionA, connectionB]), harness.deps);
    const activeConnectionIds: Array<string | null> = [controller.getSnapshot().activeConnectionId];
    const adoptedClients: Array<DaemonClient | null> = [controller.getSnapshot().client];
    const probeIdsAfterRemoval: string[][] = [];
    let removalResolved = false;
    controller.subscribe(() => {
      const snapshot = controller.getSnapshot();
      activeConnectionIds.push(snapshot.activeConnectionId);
      adoptedClients.push(snapshot.client);
      if (removalResolved) {
        probeIdsAfterRemoval.push(Array.from(snapshot.probeByConnectionId.keys()));
      }
    });
    expect(controller.getSnapshot()).toMatchObject({ activeConnectionId: null, client: null });

    const starting = controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.probeAttempts).toEqual([connectionA.id, connectionB.id]);
    expect(harness.createdClients).toHaveLength(1);
    const probeClientA = harness.createdClients[0]!.client;
    expect(probeClientA.connect).toHaveBeenCalledOnce();
    expect(probeClientA.close).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ activeConnectionId: null, client: null });
    expect(controller.getSnapshot().probeByConnectionId.get(connectionA.id)?.status).toBe(
      "pending",
    );
    expect(controller.getSnapshot().probeByConnectionId.get(connectionB.id)?.status).toBe(
      "unavailable",
    );

    const removing = controller.updateHost(makeHost([connectionB]));
    // Let removal reach its in-flight-cycle wait before A's connection resolves.
    await vi.advanceTimersByTimeAsync(0);
    resolveProbeA();
    await Promise.all([starting, removing]);
    removalResolved = true;
    probeIdsAfterRemoval.push(Array.from(controller.getSnapshot().probeByConnectionId.keys()));

    expect(controller.getSnapshot()).toMatchObject({ activeConnectionId: null, client: null });
    expect(activeConnectionIds).not.toContain(connectionA.id);
    expect(adoptedClients).not.toContain(probeClientA);
    expect(probeClientA.close).toHaveBeenCalled();
    expect(controller.getSnapshot().probeByConnectionId.has(connectionA.id)).toBe(false);

    const attemptsAtRemoval = harness.probeAttempts.length;
    await vi.advanceTimersByTimeAsync(60_000);
    const laterAttempts = harness.probeAttempts.slice(attemptsAtRemoval);
    expect(laterAttempts.length).toBeGreaterThan(0);
    expect(laterAttempts.every((id) => id === connectionB.id)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ activeConnectionId: null, client: null });
    expect(activeConnectionIds).not.toContain(connectionA.id);
    expect(adoptedClients).not.toContain(probeClientA);
    expect(probeIdsAfterRemoval.every((ids) => !ids.includes(connectionA.id))).toBe(true);
    expect(harness.createdClients).toHaveLength(1);
  });
});
