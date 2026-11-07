import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRedactor, redact, redactJson } from "../src/redact.js";

// Fake key bodies, built at runtime so no secret-shaped literal sits in the repo for scanners.
const body = (n: number, alphabet = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xYz") =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");

const CASES: Array<[string, string]> = [
  ["ANTHROPIC_API_KEY", `sk-ant-api03-${body(40)}-${body(8)}`],
  ["OPENAI_API_KEY", `sk-proj-${body(40)}_${body(10)}`],
  ["OPENAI_API_KEY", `sk-${body(48)}`],
  ["OPENAI_API_KEY", `sk-svcacct-${body(40)}`],
  ["GITHUB_TOKEN", `ghp_${body(36)}`],
  ["GITHUB_TOKEN", `gho_${body(36)}`],
  ["GITHUB_TOKEN", `ghu_${body(36)}`],
  ["GITHUB_TOKEN", `ghs_${body(36)}`],
  ["GITHUB_TOKEN", `ghr_${body(36)}`],
  ["GITHUB_TOKEN", `github_pat_${body(22)}_${body(59)}`],
  ["STRIPE_SECRET_KEY", `sk_live_${body(24)}`],
  ["STRIPE_SECRET_KEY", `sk_test_${body(24)}`],
  ["STRIPE_RESTRICTED_KEY", `rk_live_${body(24)}`],
  ["STRIPE_RESTRICTED_KEY", `rk_test_${body(24)}`],
  ["STRIPE_WEBHOOK_SECRET", `whsec_${body(32)}+/=`],
  ["ANYBENCH_API_KEY", `ab_live_${body(32)}`],
];

describe("redact (TDM-9)", () => {
  it.each(CASES)("pattern %s: %s", (name, key) => {
    const token = `[REDACTED:${name}]`;
    expect(redact(key)).toBe(token);
    expect(redact(`export KEY=${key}; echo done`)).toBe(`export KEY=${token}; echo done`);
    expect(redact(`Authorization: Bearer ${key}`)).toBe(`Authorization: Bearer ${token}`);
    // glued to a JSON escape or another word: still redacted
    expect(redact(`line\\n${key}\\n`)).toBe(`line\\n${token}\\n`);
    const json = JSON.stringify({ env: { KEY: key }, note: `using ${key}` });
    const out = redact(json);
    expect(out).not.toContain(key);
    expect(JSON.parse(out)).toEqual({ env: { KEY: token }, note: `using ${token}` });
  });

  it("leaves ordinary text alone", () => {
    for (const s of [
      "task-management-system-for-teams",
      "disk-usage is fine",
      "the sk- prefix",
      "ghp_short",
      "pk_live_publishable_is_not_secret",
      "risk_test_plan",
      "[REDACTED:OPENAI_API_KEY]",
    ]) {
      expect(redact(s)).toBe(s);
    }
  });

  it("exact-match secrets in scope, by name, including inside JSON and stream-json lines", () => {
    const secrets = {
      vultr_api_key: "V7XQ2PL9MMZ0ABCD",
      DB_PASSWORD: 'p@ss"w\\rd/with\nnewline',
      EMPTY: "",
      MISSING: undefined,
    };
    const r = createRedactor(secrets);
    expect(r("curl -H 'Authorization: Bearer V7XQ2PL9MMZ0ABCD' https://api.vultr.com")).toBe(
      "curl -H 'Authorization: Bearer [REDACTED:VULTR_API_KEY]' https://api.vultr.com",
    );

    // the value inside a JSON document is escaped; still matched, and the JSON stays valid
    const doc = JSON.stringify({ password: secrets.DB_PASSWORD, key: secrets.vultr_api_key });
    const redactedDoc = r(doc);
    expect(JSON.parse(redactedDoc)).toEqual({
      password: "[REDACTED:DB_PASSWORD]",
      key: "[REDACTED:VULTR_API_KEY]",
    });

    // stream-json: a tool_result whose content is itself a JSON string (escaped twice)
    const inner = JSON.stringify({
      stdout: `conn=${secrets.DB_PASSWORD} key=${secrets.vultr_api_key}`,
    });
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: inner }] },
    });
    const redactedLine = r(line);
    expect(redactedLine).not.toContain("V7XQ2PL9MMZ0ABCD");
    expect(redactedLine).not.toContain("with");
    const parsed = JSON.parse(redactedLine) as { message: { content: Array<{ content: string }> } };
    expect(JSON.parse(parsed.message.content[0]!.content)).toEqual({
      stdout: "conn=[REDACTED:DB_PASSWORD] key=[REDACTED:VULTR_API_KEY]",
    });
  });

  it("exact match wins over the pattern and keeps the secret's own name", () => {
    const key = `sk-ant-api03-${body(40)}`;
    expect(redact(`k=${key}`, { CUSTOMER_ANTHROPIC_KEY: key })).toBe(
      "k=[REDACTED:CUSTOMER_ANTHROPIC_KEY]",
    );
  });

  it("a secret containing another secret is replaced whole", () => {
    expect(redact("AAAA-BBBB-CCCC", { SHORT: "BBBB", LONG: "AAAA-BBBB-CCCC" })).toBe(
      "[REDACTED:LONG]",
    );
  });

  it("property: no exact secret survives in any surrounding text, raw or JSON-encoded", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 6, maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        (secret, pre, post) => {
          fc.pre(!pre.includes(secret) && !post.includes(secret) && !/[[\]]/.test(secret));
          const r = createRedactor({ S: secret });
          expect(r(pre + secret + post)).not.toContain(secret);
          const out = r(JSON.stringify({ a: pre + secret + post }));
          expect(out).not.toContain(JSON.stringify(secret).slice(1, -1));
          expect(() => JSON.parse(out)).not.toThrow();
        },
      ),
    );
  });

  it("redactJson walks values and keys without mutating the input", () => {
    const key = `ghp_${body(36)}`;
    const input = { argv: ["--token", key], nested: { [key]: 1, n: 5, ok: true, none: null } };
    const out = redactJson(input, { X: "never-present-value" });
    expect(out).toEqual({
      argv: ["--token", "[REDACTED:GITHUB_TOKEN]"],
      nested: { "[REDACTED:GITHUB_TOKEN]": 1, n: 5, ok: true, none: null },
    });
    expect(input.argv[1]).toBe(key);
  });
});
