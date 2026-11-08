// TDM-16: per-trial Naïve proxy credentials for Claude Code. Offline: FakeProxyKeys, a recording
// computers stub, and a mocked fetch replaying the key shapes recorded live on 2026-11-08
// (docs/findings/claude-code-naive-proxy.md).
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_NAIVE_DISABLED_CAPABILITIES,
  claudeCodeProxyEnv,
  FakeProxyKeys,
  liveProxyKeys,
  mintTrialProxyCredential,
  NaiveAuthError,
  provisionClaudeCodeProxyEnv,
  renderEnvFile,
  revokeStaleTrialProxyKeys,
  revokeTrialProxyCredential,
  TRIAL_PROXY_KEY_PREFIX,
  writeEnvFileToComputer,
  type NaiveExecResult,
  type NaiveMintedKey,
} from "../src/index.js";

const CMP = "cmp_01a1b922fb0970e5b8cc0f0e63a434c5";

/** Records every call; `stat` reports the mode/size the test chooses (default: 600 + real size). */
function tdm16Computers(opts: { statMode?: string; failWrite?: boolean } = {}) {
  const calls: Array<{ op: "mkdir" | "writeFile" | "exec"; arg: string }> = [];
  const files = new Map<string, string>();
  const ok = (stdout = ""): NaiveExecResult => ({
    stdout,
    stderr: "",
    exitCode: 0,
    durationMs: 1,
    timedOut: false,
    truncated: false,
  });
  return {
    calls,
    files,
    api: {
      mkdir: async (_id: string, path: string) => {
        calls.push({ op: "mkdir", arg: path });
      },
      writeFile: async (_id: string, path: string, content: Uint8Array) => {
        calls.push({ op: "writeFile", arg: path });
        if (opts.failWrite) throw new Error("fs write failed");
        files.set(path, new TextDecoder().decode(content));
      },
      exec: async (_id: string, command: string) => {
        calls.push({ op: "exec", arg: command });
        if (command.includes("stat -c")) {
          const size = [...files.values()].map((c) => new TextEncoder().encode(c).byteLength)[0];
          return ok(`${opts.statMode ?? "600"} ${size ?? 0}\n`);
        }
        return ok();
      },
    },
  };
}

describe("TDM-16 mintTrialProxyCredential", () => {
  it("mints a proxy:write-only key named after the trial and derives ANTHROPIC_BASE_URL", async () => {
    const keys = new FakeProxyKeys();
    const cred = await mintTrialProxyCredential(keys, {
      trialId: "run1.trial-7",
      baseUrl: "https://api.vetta.sh/",
    });
    expect(cred.anthropicBaseUrl).toBe("https://api.vetta.sh/v1/proxy/anthropic");
    const stored = keys.keys.get(cred.keyId)!;
    expect(stored.name).toBe(`${TRIAL_PROXY_KEY_PREFIX}run1.trial-7`);
    expect(stored.scopes).toEqual(["proxy:write"]);
    expect(cred.secret).toBe(stored.secret);
  });

  it("refuses a trial id that could break the key name", async () => {
    await expect(
      mintTrialProxyCredential(new FakeProxyKeys(), { trialId: "a b" }),
    ).rejects.toThrow();
  });

  it("revokes and throws when the server grants other scopes", async () => {
    const keys = new FakeProxyKeys();
    const wide = Object.assign(keys, {
      create: async (body: { name: string }): Promise<NaiveMintedKey> => {
        const k = await FakeProxyKeys.prototype.create.call(keys, {
          name: body.name,
          scopes: ["proxy:write"],
        });
        return { ...k, scopes: ["proxy:write", "admin"] };
      },
    });
    await expect(mintTrialProxyCredential(wide, { trialId: "t1" })).rejects.toMatchObject({
      code: "unexpected_scopes",
    });
    expect(await keys.list()).toEqual([]);
  });

  it("revokeStaleTrialProxyKeys revokes only anybench-trial-* keys not kept", async () => {
    const keys = new FakeProxyKeys();
    const a = await mintTrialProxyCredential(keys, { trialId: "a" });
    const b = await mintTrialProxyCredential(keys, { trialId: "b" });
    const other = await keys.create({ name: "worker-key", scopes: ["proxy:write"] });
    const revoked = await revokeStaleTrialProxyKeys(keys, new Set([b.keyId]));
    expect(revoked).toEqual([a.keyId]);
    expect((await keys.list()).map((k) => k.id).sort()).toEqual([b.keyId, other.id].sort());
    await revokeTrialProxyCredential(keys, b);
    await revokeTrialProxyCredential(keys, b);
    expect((await keys.list()).map((k) => k.id)).toEqual([other.id]);
  });
});

describe("TDM-16 claudeCodeProxyEnv", () => {
  const cred = { anthropicBaseUrl: "https://api.vetta.sh/v1/proxy/anthropic", secret: "sk_test_x" };

  it("sets the base URL, token, Naïve model ids and the switches the proxy needs", () => {
    const env = claudeCodeProxyEnv(cred, {
      model: "anthropic/claude-sonnet-4.6",
      smallFastModel: "anthropic/claude-haiku-4.5",
    });
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.vetta.sh/v1/proxy/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk_test_x",
      ANTHROPIC_MODEL: "anthropic/claude-sonnet-4.6",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-sonnet-4.6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-sonnet-4.6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-4.5",
      ANTHROPIC_SMALL_FAST_MODEL: "anthropic/claude-haiku-4.5",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      MAX_THINKING_TOKENS: "0",
    });
    expect(env.CLAUDE_CODE_MODEL_CAPABILITIES!.split(",")).toEqual(
      CLAUDE_CODE_NAIVE_DISABLED_CAPABILITIES.map((c) => `-${c}`),
    );
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("refuses Anthropic-catalogue ids, which the proxy rejects", () => {
    expect(() => claudeCodeProxyEnv(cred, { model: "claude-sonnet-4-6" })).toThrow(
      /Naïve catalogue id/,
    );
    expect(() =>
      claudeCodeProxyEnv(cred, { model: "~anthropic/claude-opus-latest" }),
    ).not.toThrow();
  });
});

describe("TDM-16 renderEnvFile", () => {
  it("single-quotes values so sh and node --env-file both read them", () => {
    expect(renderEnvFile({ A: "x y", B: "https://h/p?q=1" })).toBe(
      "A='x y'\nB='https://h/p?q=1'\n",
    );
  });
  it("refuses values that would break out of the quoting", () => {
    expect(() => renderEnvFile({ A: "x'y" })).toThrow();
    expect(() => renderEnvFile({ A: "x\ny" })).toThrow();
    expect(() => renderEnvFile({ "a-b": "x" })).toThrow();
  });
});

describe("TDM-16 writeEnvFileToComputer", () => {
  it("writes the file in a 0700 dir, pre-created 0600, verified, and keeps the secret off every exec", async () => {
    const c = tdm16Computers();
    const secret = "sk_test_tdm16SECRETvalue";
    const out = await writeEnvFileToComputer(c.api, CMP, { ANTHROPIC_AUTH_TOKEN: secret });
    expect(out).toEqual({
      fsPath: "/home/naive/.anybench/proxy.env",
      shellPath: "$HOME/.anybench/proxy.env",
    });
    expect(c.files.get("/home/naive/.anybench/proxy.env")).toBe(
      `ANTHROPIC_AUTH_TOKEN='${secret}'\n`,
    );
    for (const call of c.calls.filter((x) => x.op === "exec"))
      expect(call.arg).not.toContain(secret);
    const ops = c.calls.map((x) => `${x.op}:${x.arg.slice(0, 20)}`);
    expect(ops.indexOf('exec:umask 077 && : > "$')).toBeLessThan(
      ops.findIndex((o) => o.startsWith("writeFile")),
    );
    expect(
      c.calls.some((x) => x.op === "exec" && x.arg.includes('chmod 700 "$HOME/.anybench"')),
    ).toBe(true);
  });

  it("throws when the file is not 0600 afterwards", async () => {
    const c = tdm16Computers({ statMode: "644" });
    await expect(writeEnvFileToComputer(c.api, CMP, { A: "1" })).rejects.toMatchObject({
      code: "env_file_unverified",
    });
  });

  it("refuses a path that escapes the home directory", async () => {
    const c = tdm16Computers();
    await expect(
      writeEnvFileToComputer(c.api, CMP, { A: "1" }, { relPath: "../etc/x" }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(c.calls).toEqual([]);
  });
});

describe("TDM-16 provisionClaudeCodeProxyEnv", () => {
  it("mints, writes and returns both; the file names the minted secret", async () => {
    const keys = new FakeProxyKeys();
    const c = tdm16Computers();
    const r = await provisionClaudeCodeProxyEnv(
      { keys, computers: c.api },
      { trialId: "t9", computerId: CMP, model: "anthropic/claude-opus-5.5" },
    );
    const text = c.files.get(r.envFile.fsPath)!;
    expect(text).toContain(`ANTHROPIC_AUTH_TOKEN='${r.credential.secret}'`);
    expect(text).toContain("ANTHROPIC_BASE_URL='https://api.vetta.sh/v1/proxy/anthropic'");
    expect(await keys.list()).toHaveLength(1);
  });

  it("revokes the key when the file cannot be written", async () => {
    const keys = new FakeProxyKeys();
    const c = tdm16Computers({ failWrite: true });
    await expect(
      provisionClaudeCodeProxyEnv(
        { keys, computers: c.api },
        { trialId: "t9", computerId: CMP, model: "anthropic/claude-opus-5.5" },
      ),
    ).rejects.toThrow("fs write failed");
    expect(await keys.list()).toEqual([]);
  });

  it("validates the model before minting anything", async () => {
    const keys = new FakeProxyKeys();
    await expect(
      provisionClaudeCodeProxyEnv(
        { keys, computers: tdm16Computers().api },
        { trialId: "t9", computerId: CMP, model: "claude-opus-4-6" },
      ),
    ).rejects.toThrow();
    expect(keys.keys.size).toBe(0);
  });
});

describe("TDM-16 liveProxyKeys (recorded shapes, mocked fetch)", () => {
  const KEY = "key_tv66nygde2vxhgp4bs7patwbky";
  const minted = {
    id: KEY,
    object: "api_key",
    name: "anybench-trial-tdm16-spike",
    prefix: "sk_test_tdm1",
    scopes: ["proxy:write"],
    created_by: { type: "key", id: "key_e39ffvybcqd2khza0fc0mdsect" },
    last_used_at: null,
    created_at: "2026-11-08T03:19:05.000Z",
    secret: "sk_test_tdm16recordedfake",
    org_id: "org_1enjkr1qvbf8eqsj1arspaf10q",
    mode: "live",
  };

  function tdm16Fetch(routes: Record<string, { status: number; body: unknown }>) {
    const sent: Array<{ method: string; path: string; body: unknown }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const method = init?.method ?? "GET";
      sent.push({
        method,
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const r = routes[`${method} ${url.pathname}`] ?? {
        status: 404,
        body: { error: { type: "not_found", code: "not_found", message: "no", request_id: "r" } },
      };
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    return { fetch, sent };
  }

  it("creates with exactly [proxy:write], lists, and treats a 404 revoke as done", async () => {
    const { fetch, sent } = tdm16Fetch({
      "POST /v1/api_keys": { status: 201, body: minted },
      "GET /v1/api_keys": {
        status: 200,
        body: {
          data: [{ ...minted, secret: undefined, org_id: undefined, mode: undefined }],
          has_more: false,
          next_cursor: null,
        },
      },
    });
    const keys = liveProxyKeys({ apiKey: "sk_test_admin", fetch });
    const cred = await mintTrialProxyCredential(keys, { trialId: "tdm16-spike" });
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/v1/api_keys",
      body: { name: "anybench-trial-tdm16-spike", scopes: ["proxy:write"] },
    });
    expect(cred).toMatchObject({ keyId: KEY, secret: "sk_test_tdm16recordedfake" });
    expect((await keys.list()).map((k) => k.name)).toEqual(["anybench-trial-tdm16-spike"]);
    await expect(keys.revoke(KEY)).resolves.toBeUndefined();
    expect(sent.at(-1)).toMatchObject({ method: "DELETE", path: `/v1/api_keys/${KEY}` });
  });

  it("maps a 403 (key without admin) to NaiveAuthError", async () => {
    const { fetch } = tdm16Fetch({
      "POST /v1/api_keys": {
        status: 403,
        body: {
          error: {
            type: "permission",
            code: "forbidden",
            message: "this API key is missing the `admin` scope",
            request_id: "req_x",
          },
        },
      },
    });
    await expect(
      mintTrialProxyCredential(liveProxyKeys({ apiKey: "sk_test_noadmin", fetch }), {
        trialId: "t",
      }),
    ).rejects.toBeInstanceOf(NaiveAuthError);
  });
});
