// Naïve hosted apps (`client.apps`), Anybench-shaped. TDM-154 deploys the API as a `fullstack` app:
// a Vercel project in Naïve's team (docs/findings/naive-hosting.md, section 2). Only the calls the
// deploy script needs are here: find or create, deploy files, redeploy, poll, and write-only
// secrets. Replies are validated with zod; SDK errors map onto the typed NaiveError classes.
//
// Facts this follows (docs/reference/naive-sdk-apps.md and the TDM-170 spike):
// - `create` is idempotent on the name; a fullstack app's backend advances on `get`.
// - `deploy` takes path -> base64 files and an opaque `content_hash` the platform echoes back.
// - Secrets are write-only and reach the runtime only on the NEXT deployment.
// - `DATABASE_*` and `VETTA_MCP_TOKEN` are platform-managed names; setting them is `forbidden`.
// - `setSecret` stores an opaque `value_hash` we send and echoes it on `secrets`, so a caller can
//   skip writing an unchanged value without ever reading one back.

import { createClient, type VettaClient } from "@usenaive-sdk/managed-agents";
import { z } from "zod";
import type { NaiveClientOptions } from "./client.js";
import { DEFAULT_NAIVE_BASE_URL } from "./client.js";
import { mapNaiveError } from "./errors.js";

export const NaiveAppSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.enum(["frontend_only", "fullstack", "bundle"]),
  status: z.enum(["error", "active", "provisioning"]),
  url: z.string().nullable(),
  error: z.string().nullable(),
  mcp: z.string().nullable(),
  created_at: z.string(),
});
export type NaiveApp = z.infer<typeof NaiveAppSchema>;

export const NaiveAppDeploymentSchema = z.object({
  id: z.string().min(1),
  app_id: z.string(),
  status: z.enum(["error", "queued", "ready", "building"]),
  url: z.string().nullable(),
  error: z.string().nullable(),
  content_hash: z.string().nullable(),
  created_at: z.string(),
});
export type NaiveAppDeployment = z.infer<typeof NaiveAppDeploymentSchema>;

export const NaiveAppSecretSchema = z.object({
  name: z.string(),
  value_hash: z.string().nullable(),
  created_at: z.string().optional(),
});
export type NaiveAppSecret = z.infer<typeof NaiveAppSecretSchema>;

/** Secret names the platform owns on a fullstack app (setSecret answers `forbidden`). */
export const NAIVE_MANAGED_SECRET = /^(DATABASE_[A-Z0-9_]*|VETTA_MCP_TOKEN)$/;
export const APP_SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

export interface NaiveAppsApi {
  /** The app named `name`, or undefined. */
  findByName(name: string): Promise<NaiveApp | undefined>;
  create(body: {
    name: string;
    type: "fullstack" | "frontend_only";
    description?: string;
    mcp?: string;
  }): Promise<NaiveApp>;
  get(id: string): Promise<NaiveApp>;
  deploy(
    id: string,
    files: Record<string, string>,
    contentHash?: string,
  ): Promise<NaiveAppDeployment>;
  redeploy(id: string, fromDeployment: string): Promise<NaiveAppDeployment>;
  /** Newest first. */
  deployments(id: string, limit?: number): Promise<NaiveAppDeployment[]>;
  secrets(id: string): Promise<NaiveAppSecret[]>;
  /** Write-only. `valueHash` is opaque to Naïve and echoed back by `secrets`. */
  setSecret(id: string, name: string, value: string, valueHash?: string): Promise<NaiveAppSecret>;
  deleteSecret(id: string, name: string): Promise<boolean>;
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapNaiveError(error);
  }
}

export function liveApps(sdk: VettaClient): NaiveAppsApi {
  const apps = sdk.apps;
  return {
    async findByName(name) {
      const page = await call(() => apps.list({ name, limit: 100 }));
      const hit = page.data.find((a) => a.name === name);
      return hit ? NaiveAppSchema.parse(hit) : undefined;
    },
    async create(body) {
      return NaiveAppSchema.parse(await call(() => apps.create(body)));
    },
    async get(id) {
      return NaiveAppSchema.parse(await call(() => apps.get(id)));
    },
    async deploy(id, files, contentHash) {
      return NaiveAppDeploymentSchema.parse(await call(() => apps.deploy(id, files, contentHash)));
    },
    async redeploy(id, fromDeployment) {
      return NaiveAppDeploymentSchema.parse(await call(() => apps.redeploy(id, fromDeployment)));
    },
    async deployments(id, limit = 10) {
      const page = await call(() => apps.deployments(id, { limit }));
      return z.array(NaiveAppDeploymentSchema).parse(page.data);
    },
    async secrets(id) {
      const list = await call(() => apps.secrets(id));
      return z.array(NaiveAppSecretSchema).parse(list.data);
    },
    async setSecret(id, name, value, valueHash) {
      if (!APP_SECRET_NAME.test(name)) throw new Error(`invalid app secret name ${name}`);
      if (NAIVE_MANAGED_SECRET.test(name)) {
        throw new Error(`${name} is managed by the Naïve platform and cannot be set`);
      }
      const res = await call(() =>
        apps.setSecret(id, { name, value, ...(valueHash ? { value_hash: valueHash } : {}) }),
      );
      return NaiveAppSecretSchema.parse(res);
    },
    async deleteSecret(id, name) {
      const res = await call(() => apps.deleteSecret(id, name));
      return z.object({ deleted: z.boolean() }).parse(res).deleted;
    },
  };
}

/** Live apps client. Never call this in a test without `NAIVE_LIVE=1`. */
export function createNaiveApps(options: NaiveClientOptions): NaiveAppsApi {
  const sdk = createClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? DEFAULT_NAIVE_BASE_URL,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  });
  return liveApps(sdk);
}
