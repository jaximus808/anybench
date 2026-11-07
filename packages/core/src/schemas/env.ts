// P1 eval computers: EnvSpec, written by the env designer agent (plan.md P1).
import { z } from "zod";
import { KitSlugSchema, KitPathSchema } from "./kit-primitives.js";

/** VM profiles (`packages/envs/profiles/*`). A profile is a base snapshot. */
export const ProfileNameSchema = z.enum([
  "scoring",
  "base",
  "agent-cc",
  "svc",
  "tui",
  "web",
  "gui",
  "docker",
]);
export type ProfileName = z.infer<typeof ProfileNameSchema>;

/**
 * Providers behind the one `ComputeProvider` interface: `naive` (default), `docker-local` (dev, CI,
 * small Docker evals on the worker VM), `vm` (paid heavy VMs, roadmap), `fake` (unit tests).
 */
export const ComputeProviderNameSchema = z.enum(["naive", "docker-local", "vm", "fake"]);
export type ComputeProviderName = z.infer<typeof ComputeProviderNameSchema>;

/** Default provider per profile. `tui` moves off Naïve if spike 2.5 fails. `gui` is roadmap. */
export const PROFILE_DEFAULT_PROVIDER: Readonly<Record<ProfileName, ComputeProviderName>> = {
  scoring: "naive",
  base: "naive",
  "agent-cc": "naive",
  svc: "naive",
  tui: "naive",
  web: "naive",
  gui: "vm",
  docker: "docker-local",
};

/** Largest machine we run on Naïve; anything bigger, or with a GPU, needs a `vm` (roadmap). */
export const NAIVE_MAX_VCPU = 16;

export const EnvResourcesSchema = z.strictObject({
  vcpu: z.int().min(1).max(128),
  memory_gb: z.int().min(1).max(1024),
  disk_gb: z.int().min(1).max(4096),
  gpu: z.int().min(0).max(8).default(0),
});
export type EnvResources = z.infer<typeof EnvResourcesSchema>;

export const ToolchainSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
});
export type Toolchain = z.infer<typeof ToolchainSchema>;

/** A file copied into the snapshot (kit path → absolute path on the computer). */
export const EnvFixtureSchema = z.strictObject({
  src: KitPathSchema,
  dest: z.string().startsWith("/", { error: "dest must be an absolute path on the computer" }),
});
export type EnvFixture = z.infer<typeof EnvFixtureSchema>;

/** A host, optionally with a port, or a `*.` wildcard subdomain. */
const NetworkHostSchema = z
  .string()
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/, {
    error: "must be a lowercase host[:port], optionally starting with '*.'",
  });

/**
 * Declared network allow-list. On Naïve it is verified by a runner probe (allowed host + canary),
 * not enforced. A `vm` provider may enforce it.
 */
export const EnvNetworkSchema = z.strictObject({
  allow: z.array(NetworkHostSchema),
});
export type EnvNetwork = z.infer<typeof EnvNetworkSchema>;

export const HealthcheckSchema = z.strictObject({
  id: KitSlugSchema,
  /** Command run inside the computer; exit 0 means healthy. */
  command: z.string().min(1),
  timeout_s: z.int().positive().max(3600).default(60),
  retries: z.int().min(0).max(20).default(0),
});
export type Healthcheck = z.infer<typeof HealthcheckSchema>;

export const EnvSpecSchema = z
  .strictObject({
    profile: ProfileNameSchema,
    /** Omit to take `PROFILE_DEFAULT_PROVIDER[profile]` (or `vm` when the resources need it). */
    provider: ComputeProviderNameSchema.optional(),
    resources: EnvResourcesSchema,
    os_packages: z.array(z.string().min(1)).default([]),
    toolchains: z.array(ToolchainSchema).default([]),
    /** Service catalog recipes (`packages/envs/recipes/<name>`), e.g. `postgres16`, `redis7`. */
    recipes: z.array(KitSlugSchema).default([]),
    fixtures: z.array(EnvFixtureSchema).default([]),
    network: EnvNetworkSchema.default({ allow: [] }),
    healthchecks: z.array(HealthcheckSchema).default([]),
    /** Pinned region, e.g. `us-east`. Fairness: every trial in a run uses the same one. */
    region: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    const needsVm =
      env.resources.vcpu > NAIVE_MAX_VCPU ||
      env.resources.gpu > 0 ||
      PROFILE_DEFAULT_PROVIDER[env.profile] === "vm";
    if (needsVm && env.provider === "naive") {
      ctx.addIssue({
        code: "custom",
        path: ["provider"],
        message: `profile '${env.profile}' with ${env.resources.vcpu} vCPU and ${env.resources.gpu} GPU needs provider 'vm', not 'naive'`,
      });
    }
    const dup = firstDuplicate(env.recipes);
    if (dup !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["recipes"],
        message: `recipe '${dup}' is listed twice`,
      });
    }
    const dupHc = firstDuplicate(env.healthchecks.map((h) => h.id));
    if (dupHc !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["healthchecks"],
        message: `healthcheck id '${dupHc}' is used twice`,
      });
    }
  });
export type EnvSpec = z.infer<typeof EnvSpecSchema>;
export type EnvSpecInput = z.input<typeof EnvSpecSchema>;

/** The provider an EnvSpec resolves to. */
export function resolveEnvProvider(env: EnvSpec): ComputeProviderName {
  if (env.provider !== undefined) return env.provider;
  if (env.resources.vcpu > NAIVE_MAX_VCPU || env.resources.gpu > 0) return "vm";
  return PROFILE_DEFAULT_PROVIDER[env.profile];
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return undefined;
}
