// Per-trial Naïve proxy credentials for a coding agent under test (TDM-16, findings in
// docs/findings/claude-code-naive-proxy.md).
//
// Claude Code on a Naïve computer gets its model tokens from Naïve's Anthropic-compatible proxy
// (`<baseUrl>/v1/proxy/anthropic`), paid from Naïve credit, instead of a direct Anthropic key.
// For each trial we mint a key that holds only `proxy:write`, write it into the computer as a
// 0600 env file (never on an exec argv), and revoke it when the trial ends.

import { createClient, type VettaClient } from "@usenaive-sdk/managed-agents";
import { z } from "zod";
import { DEFAULT_NAIVE_BASE_URL } from "./client.js";
import { NAIVE_DEFAULT_FS_HOME, type NaiveComputersApi } from "./computers.js";
import { mapNaiveError, NaiveError } from "./errors.js";

/** Every trial key is named `<prefix><trialId>`, so a reaper can find and revoke leftovers. */
export const TRIAL_PROXY_KEY_PREFIX = "anybench-trial-";

/** The only scope a trial key gets: it may spend on model calls and nothing else that writes. */
export const TRIAL_PROXY_KEY_SCOPES = ["proxy:write"] as const;

/** The minimal key surface we need (`client.keys` in the SDK; needs a key holding `admin`). */
export interface NaiveProxyKeysApi {
  create(body: { name: string; scopes: readonly "proxy:write"[] }): Promise<NaiveMintedKey>;
  list(): Promise<NaiveKeySummary[]>;
  /** Immediate: the next request on the secret is a 401. Idempotent for a key that is already gone. */
  revoke(id: string): Promise<void>;
}

export interface NaiveMintedKey {
  id: string;
  name: string;
  scopes: string[];
  /** Shown once, at create. Never log it. */
  secret: string;
}

export interface NaiveKeySummary {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
}

export interface TrialProxyCredential {
  trialId: string;
  keyId: string;
  /** The `proxy:write` secret. Never log it or put it on a command line. */
  secret: string;
  /** Naïve API base, e.g. `https://api.vetta.sh`. */
  baseUrl: string;
  /** What `ANTHROPIC_BASE_URL` must be: `<baseUrl>/v1/proxy/anthropic`. */
  anthropicBaseUrl: string;
}

const TrialIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "trial id must be [A-Za-z0-9._-]");

/**
 * A Naïve model id as the catalogue lists it (`anthropic/claude-sonnet-4.6`), not an Anthropic id
 * (`claude-sonnet-4-6`): the proxy refuses ids from other providers' catalogues.
 */
export const NaiveModelIdSchema = z
  .string()
  .regex(
    /^~?[a-z0-9-]+\/[A-Za-z0-9._:-]+$/,
    "expected a Naïve catalogue id like anthropic/claude-sonnet-4.6",
  );

/** Live `client.keys` over the SDK. The key passed here must hold `admin` (minting keys needs it). */
export function liveProxyKeys(options: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}): NaiveProxyKeysApi {
  const sdk: VettaClient = createClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? DEFAULT_NAIVE_BASE_URL,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw mapNaiveError(error);
    }
  };
  return {
    create: async (body) => {
      const k = await call(() => sdk.keys.create({ name: body.name, scopes: [...body.scopes] }));
      return { id: k.id, name: k.name, scopes: [...k.scopes], secret: k.secret };
    },
    list: async () => {
      const out: NaiveKeySummary[] = [];
      let after: string | undefined;
      do {
        const page = await call(() => sdk.keys.list({ limit: 100, ...(after ? { after } : {}) }));
        for (const k of page.data)
          out.push({ id: k.id, name: k.name, scopes: [...k.scopes], createdAt: k.created_at });
        after = page.has_more ? (page.next_cursor ?? undefined) : undefined;
      } while (after);
      return out;
    },
    revoke: async (id) => {
      try {
        await sdk.keys.revoke(id);
      } catch (error) {
        const mapped = mapNaiveError(error);
        if (mapped.status === 404) return;
        throw mapped;
      }
    },
  };
}

/** Mints a `proxy:write` key named `anybench-trial-<trialId>` for one trial. Revoke it when the trial ends. */
export async function mintTrialProxyCredential(
  keys: NaiveProxyKeysApi,
  opts: { trialId: string; baseUrl?: string },
): Promise<TrialProxyCredential> {
  const trialId = TrialIdSchema.parse(opts.trialId);
  const baseUrl = z
    .string()
    .url()
    .parse(opts.baseUrl ?? DEFAULT_NAIVE_BASE_URL)
    .replace(/\/+$/, "");
  const key = await keys.create({
    name: `${TRIAL_PROXY_KEY_PREFIX}${trialId}`,
    scopes: TRIAL_PROXY_KEY_SCOPES,
  });
  if (key.scopes.length !== 1 || key.scopes[0] !== "proxy:write") {
    await keys.revoke(key.id);
    throw new NaiveError(
      `minted key has scopes [${key.scopes.join(", ")}], expected [proxy:write]`,
      {
        code: "unexpected_scopes",
      },
    );
  }
  return {
    trialId,
    keyId: key.id,
    secret: key.secret,
    baseUrl,
    anthropicBaseUrl: `${baseUrl}/v1/proxy/anthropic`,
  };
}

/** Revokes the trial's key. Safe to call twice. */
export async function revokeTrialProxyCredential(
  keys: NaiveProxyKeysApi,
  cred: Pick<TrialProxyCredential, "keyId">,
): Promise<void> {
  await keys.revoke(cred.keyId);
}

/** Revokes every `anybench-trial-*` key not in `keep` (for the reaper). Returns the revoked ids. */
export async function revokeStaleTrialProxyKeys(
  keys: NaiveProxyKeysApi,
  keep: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const revoked: string[] = [];
  for (const k of await keys.list()) {
    if (!k.name.startsWith(TRIAL_PROXY_KEY_PREFIX) || keep.has(k.id)) continue;
    await keys.revoke(k.id);
    revoked.push(k.id);
  }
  return revoked;
}

/**
 * Claude Code capabilities the Naïve proxy cannot carry. Claude Code infers them from the model
 * name and then sends fields the proxy refuses with 400 `validation_failed`:
 * `effort` → `output_config`, `adaptive_thinking` → `thinking: {type: "adaptive"}`,
 * `context_management` → `context_management`. Turning them off is a behaviour change: the
 * agent runs without client-chosen effort, extended thinking or server-side context editing.
 */
export const CLAUDE_CODE_NAIVE_DISABLED_CAPABILITIES = [
  "effort",
  "max_effort",
  "xhigh_effort",
  "per_turn_effort",
  "adaptive_thinking",
  "context_management",
  "rejects_disabled_thinking",
] as const;

export interface ClaudeCodeProxyEnvOptions {
  /** Main model, a Naïve catalogue id (`anthropic/claude-sonnet-4.6`). */
  model: string;
  /** For Claude Code's haiku-tier work (Explore subagents, small tasks). Defaults to `model`. */
  smallFastModel?: string;
}

/**
 * The environment Claude Code needs to run on Naïve tokens. Every name/value pair here was
 * verified live with Claude Code 2.1.319 (see the findings file); drop one and the first call
 * fails with a 400 from the proxy.
 */
export function claudeCodeProxyEnv(
  cred: Pick<TrialProxyCredential, "anthropicBaseUrl" | "secret">,
  opts: ClaudeCodeProxyEnvOptions,
): Record<string, string> {
  const model = NaiveModelIdSchema.parse(opts.model);
  const small = NaiveModelIdSchema.parse(opts.smallFastModel ?? opts.model);
  return {
    ANTHROPIC_BASE_URL: cred.anthropicBaseUrl,
    // Sent as `Authorization: Bearer`; the proxy also accepts `x-api-key`.
    ANTHROPIC_AUTH_TOKEN: cred.secret,
    ANTHROPIC_MODEL: model,
    // Aliases (`sonnet`, `opus`, `haiku`, subagent defaults) must resolve to Naïve ids too.
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    ANTHROPIC_SMALL_FAST_MODEL: small,
    // Fields the proxy refuses: `context_management` (experimental betas) and enabled thinking.
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    MAX_THINKING_TOKENS: "0",
    CLAUDE_CODE_MODEL_CAPABILITIES: CLAUDE_CODE_NAIVE_DISABLED_CAPABILITIES.map(
      (c) => `-${c}`,
    ).join(","),
    // No telemetry, update checks or other calls outside the trial's measured work.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
  };
}

const EnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "env names must be [A-Z_][A-Z0-9_]*");
const EnvValueSchema = z
  .string()
  .refine(
    (v) => !/[\n\r\0']/.test(v),
    "env values must not contain newlines, NUL or single quotes",
  );

/** `KEY='value'` lines: readable by `set -a; . file` in sh and by `node --env-file`. */
export function renderEnvFile(env: Record<string, string>): string {
  const lines = Object.entries(env).map(([k, v]) => {
    EnvNameSchema.parse(k);
    EnvValueSchema.parse(v);
    return `${k}='${v}'`;
  });
  return lines.join("\n") + "\n";
}

export interface WriteEnvFileResult {
  /** Path as `fs/*` sees it (under `/home/naive`). */
  fsPath: string;
  /** The same file as a shell sees it: `$HOME/...`. Source it with `set -a; . "<path>"; set +a`. */
  shellPath: string;
}

/**
 * Writes `env` to `<home>/<relPath>` on the computer as a 0600 file inside a 0700 directory.
 * The content travels in the `fs/write` body only; the exec calls carry no secret.
 */
export async function writeEnvFileToComputer(
  computers: Pick<NaiveComputersApi, "mkdir" | "writeFile" | "exec">,
  computerId: string,
  env: Record<string, string>,
  opts: { relPath?: string; fsHome?: string } = {},
): Promise<WriteEnvFileResult> {
  const relPath = opts.relPath ?? ".anybench/proxy.env";
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(relPath) || relPath.split("/").includes("..")) {
    throw new NaiveError(`bad env file path ${relPath}`, { code: "invalid_path" });
  }
  const fsHome = (opts.fsHome ?? NAIVE_DEFAULT_FS_HOME).replace(/\/+$/, "");
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const content = renderEnvFile(env);
  const shellPath = `$HOME/${relPath}`;
  if (dir) {
    await computers.mkdir(computerId, `${fsHome}/${dir}`);
    await checkedExec(computers, computerId, `chmod 700 "$HOME/${dir}"`);
  }
  // Pre-create the file 0600 so the secret is never readable by others, even for a moment.
  await checkedExec(
    computers,
    computerId,
    `umask 077 && : > "${shellPath}" && chmod 600 "${shellPath}"`,
  );
  await computers.writeFile(computerId, `${fsHome}/${relPath}`, new TextEncoder().encode(content));
  const check = await checkedExec(
    computers,
    computerId,
    `chmod 600 "${shellPath}" && stat -c '%a %s' "${shellPath}"`,
  );
  const [mode, size] = check.trim().split(/\s+/);
  const expected = new TextEncoder().encode(content).byteLength;
  if (mode !== "600" || Number(size) !== expected) {
    throw new NaiveError(
      `env file check failed: mode ${mode}, size ${size} (expected 600, ${expected})`,
      {
        code: "env_file_unverified",
      },
    );
  }
  return { fsPath: `${fsHome}/${relPath}`, shellPath };
}

async function checkedExec(
  computers: Pick<NaiveComputersApi, "exec">,
  computerId: string,
  command: string,
): Promise<string> {
  const r = await computers.exec(computerId, command, { timeoutMs: 30_000 });
  if (r.exitCode !== 0) {
    throw new NaiveError(`exec failed (${r.exitCode}): ${r.stderr.slice(0, 500)}`, {
      code: "exec_failed",
    });
  }
  return r.stdout;
}

/**
 * One call for a trial: mint the `proxy:write` key and write the Claude Code env file.
 * If writing the file fails, the key is revoked before the error is rethrown.
 */
export async function provisionClaudeCodeProxyEnv(
  deps: {
    keys: NaiveProxyKeysApi;
    computers: Pick<NaiveComputersApi, "mkdir" | "writeFile" | "exec">;
  },
  opts: {
    trialId: string;
    computerId: string;
    baseUrl?: string;
    relPath?: string;
    fsHome?: string;
  } & ClaudeCodeProxyEnvOptions,
): Promise<{ credential: TrialProxyCredential; envFile: WriteEnvFileResult }> {
  const envOpts: ClaudeCodeProxyEnvOptions = {
    model: opts.model,
    ...(opts.smallFastModel ? { smallFastModel: opts.smallFastModel } : {}),
  };
  // Validate the model ids before minting a key.
  NaiveModelIdSchema.parse(envOpts.model);
  NaiveModelIdSchema.parse(envOpts.smallFastModel ?? envOpts.model);
  const credential = await mintTrialProxyCredential(deps.keys, {
    trialId: opts.trialId,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  });
  try {
    const envFile = await writeEnvFileToComputer(
      deps.computers,
      opts.computerId,
      claudeCodeProxyEnv(credential, envOpts),
      {
        ...(opts.relPath ? { relPath: opts.relPath } : {}),
        ...(opts.fsHome ? { fsHome: opts.fsHome } : {}),
      },
    );
    return { credential, envFile };
  } catch (error) {
    await deps.keys.revoke(credential.keyId).catch(() => undefined);
    throw error;
  }
}

/** In-memory `NaiveProxyKeysApi` for tests. */
export class FakeProxyKeys implements NaiveProxyKeysApi {
  readonly keys = new Map<string, NaiveKeySummary & { secret: string; revoked: boolean }>();
  private n = 0;
  async create(body: { name: string; scopes: readonly "proxy:write"[] }): Promise<NaiveMintedKey> {
    this.n += 1;
    const id = `key_fake${String(this.n).padStart(22, "0")}`;
    const secret = `sk_test_fake${this.n}`;
    this.keys.set(id, {
      id,
      name: body.name,
      scopes: [...body.scopes],
      createdAt: "2026-11-08T00:00:00.000Z",
      secret,
      revoked: false,
    });
    return { id, name: body.name, scopes: [...body.scopes], secret };
  }
  async list(): Promise<NaiveKeySummary[]> {
    return [...this.keys.values()]
      .filter((k) => !k.revoked)
      .map(({ id, name, scopes, createdAt }) => ({ id, name, scopes, createdAt }));
  }
  async revoke(id: string): Promise<void> {
    const k = this.keys.get(id);
    if (k) k.revoked = true;
  }
}
