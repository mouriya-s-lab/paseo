import { normalizeHostPort } from "@getpaseo/protocol/daemon-endpoints";
import { ProxyBasePathSchema } from "@getpaseo/protocol/host-connection-schema";
import type { DirectTcpHostConnection, HostConnection, HostProfile } from "@/types/host-connection";
import { z } from "zod";

const SELF_HOSTED_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SELF_HOSTED_CONNECTION_ID_PATTERN = /^selfhosted:([a-z0-9]+(?:-[a-z0-9]+)*)$/u;

const SelfHostedManifestEntrySchema = z.strictObject({
  id: z.string().regex(SELF_HOSTED_SLUG_PATTERN),
  label: z.string().trim().min(1),
  basePath: ProxyBasePathSchema,
});

export const SelfHostedManifestSchema = z
  .array(SelfHostedManifestEntrySchema)
  .superRefine((entries, context) => {
    const seenIds = new Set<string>();
    entries.forEach((entry, index) => {
      if (seenIds.has(entry.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: "Managed daemon ids must be unique",
        });
      }
      if (entry.basePath !== `/daemons/${entry.id}`) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "basePath"],
          message: "Managed daemon basePath must match its id",
        });
      }
      seenIds.add(entry.id);
    });
  });

export type SelfHostedManifestEntry = z.infer<typeof SelfHostedManifestEntrySchema>;

export interface SelfHostedBrowserTarget {
  endpoint: string;
  useTls: boolean;
}

export function isSelfHostedBuildEnabled(): boolean {
  return process.env.EXPO_PUBLIC_PASEO_SELFHOSTED === "true";
}

interface LocalDaemonOverrideLocation {
  hash: string;
  host: string;
}

export function readSelfHostedLocalDaemonOverride(input?: {
  envValue?: string;
  location?: LocalDaemonOverrideLocation;
}): string | null {
  const location =
    input?.location ??
    (typeof window === "undefined"
      ? undefined
      : { hash: window.location.hash, host: window.location.host });
  const hashOverride = location?.hash.match(/[#&]tcp=([^&#]+:\d+)/u)?.[1];
  if (hashOverride) {
    return hashOverride;
  }

  const value = (input?.envValue ?? process.env.EXPO_PUBLIC_LOCAL_DAEMON)?.trim();
  if (!value) {
    return null;
  }
  if (value === "self-hosted" && location) {
    return location.host;
  }
  return value;
}

export function parseSelfHostedManifest(value: unknown): SelfHostedManifestEntry[] {
  return SelfHostedManifestSchema.parse(value);
}

export async function fetchSelfHostedManifest(): Promise<SelfHostedManifestEntry[]> {
  const response = await fetch("/_paseo/hosts.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Self-hosted manifest request failed with HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  return parseSelfHostedManifest(payload);
}

export function readSelfHostedBrowserTarget(): SelfHostedBrowserTarget | null {
  if (typeof window === "undefined") {
    return null;
  }
  const { protocol, host, port } = window.location;
  if (protocol !== "http:" && protocol !== "https:") {
    return null;
  }
  const normalizedHost = host.trim();
  if (!normalizedHost) {
    return null;
  }
  const explicitPort = port || (protocol === "https:" ? "443" : "80");
  return {
    endpoint: port ? normalizedHost : `${normalizedHost}:${explicitPort}`,
    useTls: protocol === "https:",
  };
}

export function selfHostedConnectionId(id: string): string {
  if (!SELF_HOSTED_SLUG_PATTERN.test(id)) {
    throw new Error("Invalid managed daemon id");
  }
  return `selfhosted:${id}`;
}

export function isSelfHostedConnectionId(id: string): boolean {
  return id.startsWith("selfhosted:");
}

export function buildSelfHostedConnection(input: {
  entry: SelfHostedManifestEntry;
  endpoint: string;
  useTls: boolean;
}): DirectTcpHostConnection {
  return {
    id: selfHostedConnectionId(input.entry.id),
    type: "directTcp",
    endpoint: normalizeHostPort(input.endpoint),
    useTls: input.useTls,
    basePath: input.entry.basePath,
  };
}

function managedSlugFromConnection(connection: HostConnection): string | null {
  if (connection.type !== "directTcp" || !isSelfHostedConnectionId(connection.id)) {
    return null;
  }
  const match = connection.id.match(SELF_HOSTED_CONNECTION_ID_PATTERN);
  return match?.[1] ?? "";
}

function managedConnectionEquals(
  left: DirectTcpHostConnection,
  right: DirectTcpHostConnection,
): boolean {
  return (
    left.id === right.id &&
    left.endpoint === right.endpoint &&
    (left.useTls ?? false) === (right.useTls ?? false) &&
    left.basePath === right.basePath &&
    left.password === right.password
  );
}

export function reconcileSelfHostedHostProfiles(input: {
  profiles: readonly HostProfile[];
  manifest: readonly SelfHostedManifestEntry[];
  endpoint: string;
  useTls: boolean;
  now?: string;
}): HostProfile[] {
  const desiredById = new Map(
    input.manifest.map((entry) => [
      entry.id,
      buildSelfHostedConnection({ entry, endpoint: input.endpoint, useTls: input.useTls }),
    ]),
  );
  const labelById = new Map(input.manifest.map((entry) => [entry.id, entry.label]));
  const seenIds = new Set<string>();
  const now = input.now ?? new Date().toISOString();
  const nextProfiles: HostProfile[] = [];

  for (const profile of input.profiles) {
    let changed = false;
    let managedLabel: string | null = null;
    const nextConnections: HostConnection[] = [];

    for (const connection of profile.connections) {
      const managedId = managedSlugFromConnection(connection);
      if (managedId === null) {
        nextConnections.push(connection);
        continue;
      }

      const desired = desiredById.get(managedId);
      if (!desired || seenIds.has(managedId)) {
        changed = true;
        continue;
      }

      seenIds.add(managedId);
      managedLabel ??= labelById.get(managedId) ?? null;
      nextConnections.push(desired);
      if (connection.type !== "directTcp" || !managedConnectionEquals(connection, desired)) {
        changed = true;
      }
    }

    if (nextConnections.length === 0) {
      continue;
    }

    const nextLabel = managedLabel ?? profile.label;
    const nextPreferredConnectionId =
      profile.preferredConnectionId &&
      nextConnections.some((connection) => connection.id === profile.preferredConnectionId)
        ? profile.preferredConnectionId
        : (nextConnections[0]?.id ?? null);
    if (
      nextLabel !== profile.label ||
      nextPreferredConnectionId !== profile.preferredConnectionId
    ) {
      changed = true;
    }

    nextProfiles.push(
      changed
        ? {
            ...profile,
            label: nextLabel,
            connections: nextConnections,
            preferredConnectionId: nextPreferredConnectionId,
            updatedAt: now,
          }
        : profile,
    );
  }

  return nextProfiles;
}
