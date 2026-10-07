import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import type { HostProfile } from "@/types/host-connection";
import { SelfHostedBootstrap, type SelfHostedBootstrapStore } from "./bootstrap";
import type { SelfHostedManifestEntry } from "./runtime";

const manifest: SelfHostedManifestEntry[] = [
  { id: "alpha", label: "Alpha", basePath: "/daemons/alpha" },
  { id: "beta", label: "Beta", basePath: "/daemons/beta" },
];

function createFakeStore(initialHosts: HostProfile[] = []) {
  let hosts = initialHosts;
  return {
    currentHosts: vi.fn<SelfHostedBootstrapStore["currentHosts"]>(() => hosts),
    replaceHosts: vi.fn<SelfHostedBootstrapStore["replaceHosts"]>((nextHosts) => {
      hosts = nextHosts;
    }),
    persistHosts: vi.fn<SelfHostedBootstrapStore["persistHosts"]>().mockResolvedValue(undefined),
    probeAndUpsertConnection: vi
      .fn<SelfHostedBootstrapStore["probeAndUpsertConnection"]>()
      .mockResolvedValue(undefined),
    runProbeCycleNow: vi
      .fn<SelfHostedBootstrapStore["runProbeCycleNow"]>()
      .mockResolvedValue(undefined),
  } satisfies SelfHostedBootstrapStore;
}

function stubManifest(entries: SelfHostedManifestEntry[]) {
  const fetchManifest = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(entries)));
  vi.stubGlobal("fetch", fetchManifest);
  return fetchManifest;
}

describe("SelfHostedBootstrap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("EXPO_PUBLIC_PASEO_SELFHOSTED", "true");
    vi.stubGlobal("window", { location: new URL("http://proxy.test:8080") });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("retries only the unreachable manifest daemon once and stops after success", async () => {
    const fetchManifest = stubManifest(manifest);
    const store = createFakeStore();
    const failure = new Error("Beta is temporarily unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.probeAndUpsertConnection.mockImplementationOnce(async () => undefined);
    store.probeAndUpsertConnection.mockRejectedValueOnce(failure);
    const alphaInput = {
      connection: {
        id: "selfhosted:alpha",
        type: "directTcp",
        endpoint: "proxy.test:8080",
        useTls: false,
        basePath: "/daemons/alpha",
      },
      label: "Alpha",
    };
    const betaInput = {
      connection: {
        id: "selfhosted:beta",
        type: "directTcp",
        endpoint: "proxy.test:8080",
        useTls: false,
        basePath: "/daemons/beta",
      },
      label: "Beta",
    };

    await new SelfHostedBootstrap(store).run();

    expect(fetchManifest).toHaveBeenCalledExactlyOnceWith("/_paseo/hosts.json", {
      cache: "no-store",
    });
    expect(store.probeAndUpsertConnection.mock.calls).toEqual([[alphaInput], [betaInput]]);
    expect(store.runProbeCycleNow).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith("[HostRuntime] self-hosted daemon probe failed", {
      id: "beta",
      error: failure,
    });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(store.probeAndUpsertConnection.mock.calls).toEqual([[alphaInput], [betaInput]]);

    await vi.advanceTimersByTimeAsync(1);
    expect(store.probeAndUpsertConnection.mock.calls).toEqual([
      [alphaInput],
      [betaInput],
      [betaInput],
    ]);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.probeAndUpsertConnection.mock.calls).toEqual([
      [alphaInput],
      [betaInput],
      [betaInput],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves a daemon with a stored profile to its controller and discovers only new ones", async () => {
    stubManifest(manifest);
    const now = "2026-01-01T00:00:00.000Z";
    const alphaConnection = {
      id: "selfhosted:alpha",
      type: "directTcp",
      endpoint: "proxy.test:8080",
      useTls: false,
      basePath: "/daemons/alpha",
    } as const;
    const storedAlpha: HostProfile = {
      serverId: "server-alpha",
      label: "Alpha",
      appearance: defaultHostAppearance(),
      lifecycle: {},
      connections: [alphaConnection],
      preferredConnectionId: alphaConnection.id,
      createdAt: now,
      updatedAt: now,
    };
    const store = createFakeStore([storedAlpha]);

    await new SelfHostedBootstrap(store).run();

    expect(store.probeAndUpsertConnection.mock.calls).toEqual([
      [
        {
          connection: {
            id: "selfhosted:beta",
            type: "directTcp",
            endpoint: "proxy.test:8080",
            useTls: false,
            basePath: "/daemons/beta",
          },
          label: "Beta",
        },
      ],
    ]);
    expect(store.currentHosts()).toEqual([storedAlpha]);
    expect(store.runProbeCycleNow).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes and persists a stored profile whose managed daemon left the manifest", async () => {
    stubManifest(manifest);
    const now = "2026-01-01T00:00:00.000Z";
    const storedProfile: HostProfile = {
      serverId: "server-gone",
      label: "Gone",
      appearance: defaultHostAppearance(),
      lifecycle: {},
      connections: [
        {
          id: "selfhosted:gone",
          type: "directTcp",
          endpoint: "proxy.test:8080",
          useTls: false,
          basePath: "/daemons/gone",
        },
      ],
      preferredConnectionId: "selfhosted:gone",
      createdAt: now,
      updatedAt: now,
    };
    const store = createFakeStore([storedProfile]);

    await new SelfHostedBootstrap(store).run();

    expect(store.replaceHosts).toHaveBeenCalledExactlyOnceWith([]);
    expect(store.currentHosts()).toEqual([]);
    expect(store.persistHosts).toHaveBeenCalledTimes(2);
    expect(store.replaceHosts.mock.invocationCallOrder[0]).toBeLessThan(
      store.persistHosts.mock.invocationCallOrder[0]!,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects the entire manifest when a daemon basePath does not match its id", async () => {
    stubManifest([manifest[0]!, { id: "beta", label: "Beta", basePath: "/daemons/other" }]);
    const store = createFakeStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await new SelfHostedBootstrap(store).run();

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[HostRuntime] self-hosted manifest fetch failed",
      {
        error: expect.any(Error),
      },
    );
    expect(store.currentHosts).not.toHaveBeenCalled();
    expect(store.replaceHosts).not.toHaveBeenCalled();
    expect(store.persistHosts).not.toHaveBeenCalled();
    expect(store.probeAndUpsertConnection).not.toHaveBeenCalled();
    expect(store.runProbeCycleNow).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
