import equal from "fast-deep-equal/es6";
import type { DirectTcpHostConnection, HostConnection, HostProfile } from "@/types/host-connection";
import {
  buildSelfHostedConnection,
  fetchSelfHostedManifest,
  isSelfHostedBuildEnabled,
  isSelfHostedConnectionId,
  readSelfHostedBrowserTarget,
  reconcileSelfHostedHostProfiles,
  type SelfHostedManifestEntry,
} from "./runtime";

const SELF_HOSTED_DISCOVERY_RETRY_MS = 10_000;

/**
 * Projects a host profile onto the connections the host runtime may use. In a self-hosted
 * build only the managed `selfhosted:*` connections are reachable through the proxy, so
 * every other stored connection is invisible to the runtime controller. The canonical
 * profile in `HostRuntimeStore` is untouched.
 */
export function selfHostedRuntimeHost(host: HostProfile): HostProfile {
  if (!isSelfHostedBuildEnabled()) {
    return host;
  }
  const connections = host.connections.filter(
    (connection) => connection.type === "directTcp" && isSelfHostedConnectionId(connection.id),
  );
  return connections.length === host.connections.length ? host : { ...host, connections };
}

/** The `HostRuntimeStore` operations the bootstrap drives. The store stays the owner of hosts. */
export interface SelfHostedBootstrapStore {
  currentHosts(): HostProfile[];
  replaceHosts(hosts: HostProfile[]): void;
  persistHosts(): Promise<void>;
  probeAndUpsertConnection(input: { connection: HostConnection; label?: string }): Promise<unknown>;
  runProbeCycleNow(): Promise<void>;
}

interface PendingManagedConnection {
  entry: SelfHostedManifestEntry;
  connection: DirectTcpHostConnection;
}

/**
 * Boots the host registry from the same-origin manifest: reconciles managed profiles, then
 * probes each managed daemon and keeps retrying the unreachable ones on one serialized loop.
 * Lives as long as its store; the store has no teardown.
 */
export class SelfHostedBootstrap {
  private pending = new Map<string, PendingManagedConnection>();
  private retryIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private retryInFlight: Promise<void> | null = null;

  constructor(private readonly store: SelfHostedBootstrapStore) {}

  async run(): Promise<void> {
    const target = readSelfHostedBrowserTarget();
    if (!target) {
      console.warn("[HostRuntime] self-hosted build requires an HTTP browser origin");
      return;
    }
    let manifest: SelfHostedManifestEntry[];
    try {
      manifest = await fetchSelfHostedManifest();
    } catch (error) {
      console.warn("[HostRuntime] self-hosted manifest fetch failed", { error });
      return;
    }

    const hosts = this.store.currentHosts();
    let reconciled: HostProfile[];
    try {
      reconciled = reconcileSelfHostedHostProfiles({
        profiles: hosts,
        manifest,
        endpoint: target.endpoint,
        useTls: target.useTls,
      });
    } catch (error) {
      console.warn("[HostRuntime] self-hosted manifest was rejected", { error });
      return;
    }

    if (!equal(reconciled, hosts)) {
      this.store.replaceHosts(reconciled);
      try {
        await this.store.persistHosts();
      } catch (error) {
        console.error("[HostRuntime] Failed to persist self-hosted host registry", error);
      }
    }

    this.pending = new Map(
      manifest.map((entry) => [
        entry.id,
        {
          entry,
          connection: buildSelfHostedConnection({
            entry,
            endpoint: target.endpoint,
            useTls: target.useTls,
          }),
        },
      ]),
    );
    await this.retryPending();

    try {
      await this.store.runProbeCycleNow();
    } catch (error) {
      console.error("[HostRuntime] self-hosted probe cycle failed", { error });
    }
    try {
      await this.store.persistHosts();
    } catch (error) {
      console.error("[HostRuntime] Failed to persist self-hosted host registry", { error });
    }
  }

  private async retryPending(): Promise<void> {
    const inFlight = this.retryInFlight;
    if (inFlight) {
      await inFlight;
      return;
    }

    const retry = this.probePending();
    this.retryInFlight = retry;
    try {
      await retry;
    } catch (error) {
      console.error("[HostRuntime] self-hosted daemon retry failed", { error });
    } finally {
      if (this.retryInFlight === retry) {
        this.retryInFlight = null;
      }
      this.syncRetryInterval();
    }
  }

  private async probePending(): Promise<void> {
    const pending = Array.from(this.pending.values());
    const results = await Promise.allSettled(
      pending.map(async ({ entry, connection }) => {
        await this.store.probeAndUpsertConnection({ connection, label: entry.label });
        this.pending.delete(entry.id);
      }),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        console.warn("[HostRuntime] self-hosted daemon probe failed", {
          id: pending[index]?.entry.id,
          error: result.reason,
        });
      }
    }
  }

  private syncRetryInterval(): void {
    if (this.pending.size === 0) {
      if (this.retryIntervalHandle) {
        clearInterval(this.retryIntervalHandle);
        this.retryIntervalHandle = null;
      }
      return;
    }
    if (!this.retryIntervalHandle) {
      this.retryIntervalHandle = setInterval(() => {
        void this.retryPending();
      }, SELF_HOSTED_DISCOVERY_RETRY_MS);
    }
  }
}
