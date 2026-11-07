// ensureAgent: create-or-update one Naïve agent from an Anybench agent spec, so a prompt change
// mints a new agent version and an unchanged spec is a no-op. The spec itself (prompt.md,
// output.schema.json, config.json per role) is loaded by packages/agents; this file only syncs it.

import { createHash } from "node:crypto";
import { z } from "zod";
import { HARNESSES, WINDOWS, type AgentWrite, type NaiveAgent, type NaiveClient } from "./types.js";

/** Metadata keys we stamp on every agent we own. */
export const AGENT_ROLE_KEY = "anybench_role";
export const AGENT_FINGERPRINT_KEY = "anybench_fingerprint";

export const AgentSpecSchema = z.object({
  /** Anybench role, e.g. "understander". Also what FakeNaive scripts key on. */
  role: z.string().regex(/^[a-z][a-z0-9_-]*$/, "role must be lowercase kebab/snake case"),
  /** Naïve agent name; defaults to `anybench-<role>`. */
  name: z.string().min(1).max(100).optional(),
  model: z.string().min(1),
  system: z.string().min(1),
  harness: z.enum(HARNESSES).optional(),
  window: z.enum(WINDOWS).optional(),
  description: z.string().optional(),
  budget: z.object({
    capMicroUsd: z.bigint().nonnegative(),
    maxTaskMicroUsd: z.bigint().nonnegative(),
    period: z.enum(["day", "week", "month"]).default("month"),
  }),
  /** JSON schema the session's final document must match (`output.schema.json`). */
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  tools: z.record(z.string(), z.unknown()).optional(),
});
export type AgentSpec = z.input<typeof AgentSpecSchema>;

export interface EnsuredAgent {
  agent: NaiveAgent;
  role: string;
  fingerprint: string;
  action: "created" | "updated" | "unchanged";
}

export function agentNameFor(role: string): string {
  return `anybench-${role}`;
}

/** Key-sorted JSON so the fingerprint does not depend on property order. bigint as a decimal string. */
function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function agentFingerprint(spec: AgentSpec): string {
  const parsed = AgentSpecSchema.parse(spec);
  return createHash("sha256").update(canonical(parsed)).digest("hex").slice(0, 32);
}

export function agentWriteFor(spec: AgentSpec): AgentWrite {
  const s = AgentSpecSchema.parse(spec);
  return {
    name: s.name ?? agentNameFor(s.role),
    model: s.model,
    system: s.system,
    budget: s.budget,
    ...(s.harness !== undefined ? { harness: s.harness } : {}),
    ...(s.window !== undefined ? { window: s.window } : {}),
    ...(s.description !== undefined ? { description: s.description } : {}),
    ...(s.outputSchema !== undefined
      ? { outputSchema: s.outputSchema, structuredOutputRequired: true }
      : {}),
    ...(s.tools !== undefined ? { tools: s.tools } : {}),
    metadata: { [AGENT_ROLE_KEY]: s.role, [AGENT_FINGERPRINT_KEY]: agentFingerprint(spec) },
  };
}

/**
 * Makes sure the Naïve agent for `spec.role` exists and matches the spec. Creates it when absent,
 * updates it (a new version, guarded by `expectedVersion`) when the fingerprint differs, and
 * otherwise touches nothing.
 */
export async function ensureAgent(client: NaiveClient, spec: AgentSpec): Promise<EnsuredAgent> {
  const parsed = AgentSpecSchema.parse(spec);
  const write = agentWriteFor(spec);
  const fingerprint = agentFingerprint(spec);
  const existing = await client.agents.findByName(write.name);
  if (!existing) {
    return {
      agent: await client.agents.create(write),
      role: parsed.role,
      fingerprint,
      action: "created",
    };
  }
  if (existing.metadata[AGENT_FINGERPRINT_KEY] === fingerprint) {
    return { agent: existing, role: parsed.role, fingerprint, action: "unchanged" };
  }
  const agent = await client.agents.update(existing.id, write, {
    expectedVersion: existing.version,
  });
  return { agent, role: parsed.role, fingerprint, action: "updated" };
}
