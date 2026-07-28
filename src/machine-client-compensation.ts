import type {
  ActiveMachineClientRegistration,
  MachineClientDeps,
  MachineClientMutationAudit,
  MachineClientStore,
} from "mcp-sso";

/** Disable only the credential mutation whose one-time output was lost. */
export async function disableExactCredentialVersion(
  deps: MachineClientDeps,
  clientId: string,
  expectedVersion: number,
): Promise<boolean> {
  const store = deps.store as Partial<MachineClientStore>;
  if (typeof store.compareAndSwapMachineClient !== "function") return false;
  const current = await deps.store.find(clientId);
  if (!isExactActiveMachine(current, clientId, expectedVersion)) return false;
  const nowMs = deps.clock.nowMs();
  const now = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(now) || now < 0) {
    return false;
  }
  const next = {
    ...current,
    status: "disabled" as const,
    version: current.version + 1,
    secrets: [] as [],
    disabledAtEpoch: now,
  };
  const audit: MachineClientMutationAudit = {
    occurredAt: new Date(nowMs).toISOString(),
    event: "oauth.client.disable",
    clientId,
    scopes: [...current.allowedScopes],
  };
  const changed = await store.compareAndSwapMachineClient(
    expectedVersion,
    next,
    audit,
  );
  if (changed) {
    try {
      await deps.audit.writeAuthEvent({ ...audit, status: "success" });
    } catch {
      // The transaction already committed the authoritative durable audit.
    }
  }
  return changed;
}

function isExactActiveMachine(
  value: unknown,
  clientId: string,
  version: number,
): value is ActiveMachineClientRegistration {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ActiveMachineClientRegistration>;
  return candidate.applicationType === "machine"
    && candidate.status === "active"
    && candidate.clientId === clientId
    && candidate.version === version
    && version < Number.MAX_SAFE_INTEGER;
}
