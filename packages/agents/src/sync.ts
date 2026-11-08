// TDM-55 [6.1]: deploy sync. Creates or updates the Naïve agent of every role (ensureAgent), so a
// prompt (or any config) change mints a new agent version and an unchanged role makes no write.
import {
  agentFingerprint,
  agentNameFor,
  ensureAgent,
  retryOnNaiveCapacity,
  type AgentSpec,
  type CapacityRetryOptions,
  type EnsuredAgent,
  type NaiveClient,
} from "@anybench/naive";
import {
  listRoles,
  loadRole,
  roleAgentSpec,
  type RegistryOptions,
  type RoleSpecOverrides,
} from "./registry.js";

export interface SyncOptions extends RegistryOptions {
  /** Only these roles (default: every role folder). */
  roles?: readonly string[];
  /** Per-role spec overrides (e.g. a cheaper model in a live test). */
  overrides?: Readonly<Record<string, RoleSpecOverrides>>;
  /**
   * Naïve answers 429 "at capacity" under load. A refused call wrote nothing, so ensureAgent is
   * retried whole with backoff (default: retryOnNaiveCapacity's 6 tries).
   */
  retry?: CapacityRetryOptions;
}

export interface SyncPlanItem {
  role: string;
  name: string;
  model: string;
  /** The ensureAgent fingerprint Naïve's agent metadata is compared against. */
  fingerprint: string;
  promptSha256: string;
  hasOutputSchema: boolean;
  spec: AgentSpec;
}

/** What a sync would write, without any call to Naïve (`--dry-run`). */
export function planSync(options: SyncOptions = {}): SyncPlanItem[] {
  const roles = options.roles ? [...options.roles] : listRoles(options);
  return roles.map((role) => {
    const def = loadRole(role, options);
    const spec = roleAgentSpec(def, { ...options.overrides?.[role] });
    return {
      role,
      name: spec.name ?? agentNameFor(role),
      model: spec.model,
      fingerprint: agentFingerprint(spec),
      promptSha256: def.promptSha256,
      hasOutputSchema: spec.outputSchema !== undefined,
      spec,
    };
  });
}

/** Ensures every role's agent on Naïve, in role order. Stops at the first error. */
export async function syncAgents(
  client: NaiveClient,
  options: SyncOptions = {},
): Promise<EnsuredAgent[]> {
  const plan = planSync(options);
  const out: EnsuredAgent[] = [];
  for (const item of plan) {
    out.push(
      await retryOnNaiveCapacity(
        `ensureAgent ${item.role}`,
        () => ensureAgent(client, item.spec),
        options.retry,
      ),
    );
  }
  return out;
}
