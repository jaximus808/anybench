// TDM-109 [12.1]: attestation signing, well-known keyset and verify.
// Generates its own throwaway Ed25519 keypairs; never reads .env.
import { generateKeyPairSync } from "node:crypto";
import {
  bootstrapCi,
  GATE_PASS_RATE_METRIC,
  scoreKit,
  type KitScore,
  type TrialResult,
} from "@anybench/bench";
import type { KitSpec } from "@anybench/core";
import { describe, expect, it } from "vitest";
import {
  attest,
  AttestError,
  canonicalize,
  CanonicalJsonError,
  loadSigningKey,
  PROOF_CHECK_IDS,
  PublishKeyError,
  serializeAttestation,
  verify,
  wellKnownKeys,
  WellKnownKeysSchema,
  type AttestInput,
  type SignedAttestation,
} from "../src/index.js";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

function keyEnvTdm109(keyId = "ab-test-1") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    PUBLISH_SIGNING_KEY_ID: keyId,
    PUBLISH_SIGNING_PRIVATE_KEY_DER_B64: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    PUBLISH_SIGNING_PUBLIC_KEY_DER_B64: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

const KIT_TDM109: Pick<KitSpec, "requirements" | "scoring"> = {
  requirements: [
    {
      id: "tests",
      type: "measured",
      title: "Tasks solved",
      metric: GATE_PASS_RATE_METRIC,
      better: "higher",
      gate_id: "hidden-tests",
    },
    {
      id: "time",
      type: "measured",
      title: "Median time",
      metric: "wall_s",
      unit: "s",
      better: "lower",
      gate_id: "hidden-tests",
    },
  ],
  scoring: { weights: { tests: 70, time: 30 } },
};

/** tandem passes 4/5 and 3/5, claude-code 3/5 and 2/5, do-less never passes (no score). */
function trialsTdm109(): TrialResult[] {
  const setups = [
    { id: "tandem", passes: [4, 3], wall: 600 },
    { id: "claude-code", passes: [3, 2], wall: 1100 },
    { id: "do-less", passes: [0, 0], wall: 30 },
  ];
  const out: TrialResult[] = [];
  for (const s of setups) {
    ["todo-api", "bug-hunt"].forEach((workloadId, w) => {
      for (let repeat = 0; repeat < 5; repeat++) {
        const pass = repeat < s.passes[w]!;
        out.push({
          contenderId: s.id,
          workloadId,
          repeat,
          metrics: { wall_s: s.wall + repeat * 7 },
          gates: { "hidden-tests": { pass, reason: pass ? "ok" : "2 failed", evidence: [] } },
        });
      }
    });
  }
  return out;
}

const PASSED_TDM109 = Object.fromEntries(
  PROOF_CHECK_IDS.map((id) => [id, { pass: true, detail: `${id} ok` }]),
);

function inputTdm109(score: KitScore = scoreKit(KIT_TDM109, trialsTdm109())): AttestInput {
  const ci = bootstrapCi([71.2, 74.9, 77.5, 80.1, 83.4], { seed: 109, iterations: 500 });
  return {
    kitHash: "a".repeat(64),
    runId: "019a5f00-0000-7000-8000-000000000109",
    contenders: [
      { id: "tandem", version: "tandem@0.4.2+claude-code@2.1.0" },
      { id: "claude-code", version: "claude-code@2.1.0" },
      { id: "do-less", version: "tandem@0.4.2-do-less" },
    ],
    snapshots: [{ id: "cpu-4", sha256: "b".repeat(64) }],
    proofChecks: PASSED_TDM109,
    score,
    ci: { tandem: ci },
  };
}

const NOW = new Date("2026-11-07T12:00:00.000Z");

function signedTdm109(env = keyEnvTdm109()): SignedAttestation {
  return attest(inputTdm109(), loadSigningKey(env), { now: NOW });
}

// ── canonical JSON ───────────────────────────────────────────────────────────────────────────

describe("canonicalize", () => {
  it("sorts keys, drops whitespace and undefined, writes bigints as decimal strings", () => {
    expect(
      canonicalize({ b: [1, "x", null, true], a: { d: 2n ** 70n, c: -0, e: undefined }, é: 1.5 }),
    ).toBe('{"a":{"c":0,"d":"1180591620717411303424"},"b":[1,"x",null,true],"é":1.5}');
  });

  it("orders keys by UTF-16 code units and numbers by the ES shortest form", () => {
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FFFF in UTF-16.
    expect(canonicalize({ "\uFFFF": 2, "\u{1F600}": 1, a: 1e21, B: 1e-7 })).toBe(
      '{"B":1e-7,"a":1e+21,"\u{1F600}":1,"\uFFFF":2}',
    );
  });

  it("is independent of key insertion order", () => {
    expect(canonicalize({ x: 1, y: { p: 1, q: 2 } })).toBe(
      canonicalize({ y: { q: 2, p: 1 }, x: 1 }),
    );
  });

  it("refuses values with no single JSON meaning", () => {
    for (const bad of [NaN, Infinity, [undefined], new Date(0), new Map(), () => 1, Symbol("s")]) {
      expect(() => canonicalize({ v: bad })).toThrow(CanonicalJsonError);
    }
    expect(() => canonicalize(undefined)).toThrow(CanonicalJsonError);
  });
});

// ── keys ─────────────────────────────────────────────────────────────────────────────────────

describe("keys", () => {
  it("loads the signing key from env and rejects a mismatched public half", () => {
    const env = keyEnvTdm109();
    expect(loadSigningKey(env).keyId).toBe("ab-test-1");
    const other = keyEnvTdm109();
    expect(() =>
      loadSigningKey({
        ...env,
        PUBLISH_SIGNING_PUBLIC_KEY_DER_B64: other.PUBLISH_SIGNING_PUBLIC_KEY_DER_B64,
      }),
    ).toThrow(expect.objectContaining({ code: "mismatch" }));
    expect(() => loadSigningKey({ ...env, PUBLISH_SIGNING_PRIVATE_KEY_DER_B64: "" })).toThrow(
      expect.objectContaining({ code: "missing" }),
    );
    expect(() =>
      loadSigningKey({ ...env, PUBLISH_SIGNING_PRIVATE_KEY_DER_B64: "bm90IGEga2V5" }),
    ).toThrow(PublishKeyError);
  });

  it("rejects a non-Ed25519 key", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const env = {
      ...keyEnvTdm109(),
      PUBLISH_SIGNING_PUBLIC_KEY_DER_B64: publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
    };
    expect(() => wellKnownKeys(env)).toThrow(/not Ed25519/);
  });

  it("serves the current key plus previous keys for rotation, never the private key", () => {
    const old1 = keyEnvTdm109("ab-2026-09");
    const old2 = keyEnvTdm109("ab-2026-10");
    const cur = keyEnvTdm109("ab-2026-11");
    const doc = wellKnownKeys({
      ...cur,
      PUBLISH_SIGNING_PREVIOUS_PUBLIC_KEYS: `ab-2026-10:${old2.PUBLISH_SIGNING_PUBLIC_KEY_DER_B64}, ab-2026-09:${old1.PUBLISH_SIGNING_PUBLIC_KEY_DER_B64}`,
    });
    expect(WellKnownKeysSchema.parse(doc)).toEqual(doc);
    expect(doc.keys.map((k) => [k.key_id, k.status])).toEqual([
      ["ab-2026-11", "current"],
      ["ab-2026-10", "previous"],
      ["ab-2026-09", "previous"],
    ]);
    expect(doc.keys[0]!.public_key_spki_der_b64).toBe(cur.PUBLISH_SIGNING_PUBLIC_KEY_DER_B64);
    expect(doc.keys[0]!.jwk).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    const text = JSON.stringify(doc);
    expect(text).not.toContain(cur.PUBLISH_SIGNING_PRIVATE_KEY_DER_B64);
    // Pure: needs no private key at all.
    const { PUBLISH_SIGNING_PRIVATE_KEY_DER_B64: _drop, ...publicOnly } = cur;
    expect(wellKnownKeys(publicOnly)).toEqual(wellKnownKeys(cur));
  });

  it("rejects duplicated or malformed previous keys", () => {
    const cur = keyEnvTdm109("ab-2026-11");
    expect(() =>
      wellKnownKeys({
        ...cur,
        PUBLISH_SIGNING_PREVIOUS_PUBLIC_KEYS: `ab-2026-11:${cur.PUBLISH_SIGNING_PUBLIC_KEY_DER_B64}`,
      }),
    ).toThrow(expect.objectContaining({ code: "duplicate" }));
    expect(() =>
      wellKnownKeys({ ...cur, PUBLISH_SIGNING_PREVIOUS_PUBLIC_KEYS: "no-colon-here" }),
    ).toThrow(expect.objectContaining({ code: "invalid" }));
  });
});

// ── attest ───────────────────────────────────────────────────────────────────────────────────

describe("attest", () => {
  it("signs a fixture report into a canonical-JSON attestation with every required field", () => {
    const att = signedTdm109();
    const p = att.payload;
    expect(att.alg).toBe("Ed25519");
    expect(att.key_id).toBe("ab-test-1");
    expect(p.key_id).toBe("ab-test-1");
    expect(p.kit_hash).toBe("a".repeat(64));
    expect(p.contenders.map((c) => c.contender_id)).toEqual(["tandem", "claude-code", "do-less"]);
    expect(p.contenders[0]!.version).toBe("tandem@0.4.2+claude-code@2.1.0");
    expect(p.snapshots).toEqual([{ id: "cpu-4", sha256: "b".repeat(64) }]);
    expect(p.trial_count).toBe(30);
    expect(Object.keys(p.proof_checks).sort()).toEqual([...PROOF_CHECK_IDS].sort());
    expect(p.issued_at).toBe("2026-11-07T12:00:00.000Z");
    expect(p.ranking).toEqual(["tandem", "claude-code"]);

    const tandem = p.scores.find((s) => s.contender_id === "tandem")!;
    expect(tandem.scored).toBe(true);
    expect(tandem.ci).toMatchObject({ level: 0.95 });
    const doLess = p.scores.find((s) => s.contender_id === "do-less")!;
    expect(doLess).toMatchObject({ scored: false, total: null, ci: null });
    expect(doLess.scored === false && doLess.reason).toBe("no score: gate failed");

    const text = serializeAttestation(att);
    expect(text).toBe(canonicalize(JSON.parse(text)));
    expect(Buffer.from(att.signature, "base64")).toHaveLength(64);
  });

  it("is deterministic for the same input, key and clock", () => {
    const env = keyEnvTdm109();
    expect(serializeAttestation(signedTdm109(env))).toBe(serializeAttestation(signedTdm109(env)));
  });

  it.each(PROOF_CHECK_IDS)("refuses when proof check %s failed", (id) => {
    const key = loadSigningKey(keyEnvTdm109());
    const input = inputTdm109();
    input.proofChecks = { ...PASSED_TDM109, [id]: { pass: false, detail: "nope" } };
    try {
      attest(input, key);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AttestError);
      expect((e as AttestError).code).toBe("proof_check_failed");
      expect((e as AttestError).details).toEqual([id]);
    }
  });

  it("refuses when a proof check never ran, or an unknown one is passed", () => {
    const key = loadSigningKey(keyEnvTdm109());
    const { no_secrets: _skip, ...five } = PASSED_TDM109;
    expect(() => attest({ ...inputTdm109(), proofChecks: five }, key)).toThrow(
      expect.objectContaining({ code: "proof_check_missing", details: ["no_secrets"] }),
    );
    expect(() =>
      attest({ ...inputTdm109(), proofChecks: { ...PASSED_TDM109, vibes: { pass: true } } }, key),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("refuses a contender subset, a missing version, or a CI on an ungated contender", () => {
    const key = loadSigningKey(keyEnvTdm109());
    const base = inputTdm109();
    expect(() => attest({ ...base, contenders: base.contenders.slice(0, 2) }, key)).toThrow(
      expect.objectContaining({ code: "contender_mismatch" }),
    );
    expect(() =>
      attest({ ...base, contenders: [...base.contenders, { id: "ghost", version: "1" }] }, key),
    ).toThrow(expect.objectContaining({ code: "contender_mismatch" }));
    expect(() =>
      attest({ ...base, contenders: base.contenders.map((c) => ({ ...c, version: "" })) }, key),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      attest({ ...base, ci: { "do-less": { lo: 1, hi: 2, level: 0.95, estimate: 1.5 } } }, key),
    ).toThrow(expect.objectContaining({ code: "ci_without_score" }));
    expect(() => attest({ ...base, kitHash: "nothex" }, key)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});

// ── verify ───────────────────────────────────────────────────────────────────────────────────

describe("verify", () => {
  it("passes for the original, as an object, canonical text, or bytes", () => {
    const env = keyEnvTdm109();
    const att = signedTdm109(env);
    const keys = wellKnownKeys(env);
    const text = serializeAttestation(att);
    for (const form of [att, JSON.parse(text), text, new TextEncoder().encode(text)]) {
      const r = verify(form, keys);
      expect(r).toMatchObject({ valid: true, key: { key_id: "ab-test-1", status: "current" } });
    }
  });

  it("fails for every single-byte change anywhere in the attestation", () => {
    const env = keyEnvTdm109();
    const keys = wellKnownKeys(env);
    const bytes = Buffer.from(serializeAttestation(signedTdm109(env)), "utf8");
    expect(verify(bytes, keys).valid).toBe(true);
    let checked = 0;
    for (let i = 0; i < bytes.length; i++) {
      for (const flip of [0x01]) {
        const mutated = Buffer.from(bytes);
        mutated[i] = mutated[i]! ^ flip;
        const r = verify(mutated, keys);
        if (r.valid) throw new Error(`byte ${i} ^ 0x${flip.toString(16)} still verified`);
        checked++;
      }
    }
    expect(checked).toBe(bytes.length);
  }, 60_000);

  it("fails for field edits on the parsed object", () => {
    const env = keyEnvTdm109();
    const keys = wellKnownKeys(env);
    const att = signedTdm109(env);
    const edits: ((a: SignedAttestation) => void)[] = [
      (a) => (a.payload.trial_count += 1),
      (a) => (a.payload.ranking = [...a.payload.ranking].reverse()),
      (a) => (a.payload.contenders[1]!.version = "claude-code@2.1.1"),
      (a) => {
        const s = a.payload.scores[0]!;
        if (s.scored) s.total += 1e-9;
      },
      (a) => (a.payload.issued_at = "2026-11-07T12:00:00.001Z"),
      (a) => ((a.payload as unknown as Record<string, unknown>).extra = 1),
      (a) => (a.signature = a.signature.replace(/.(?==*$)/, (c) => (c === "A" ? "B" : "A"))),
    ];
    for (const edit of edits) {
      const copy = structuredClone(att);
      edit(copy);
      expect(verify(copy, keys).valid).toBe(false);
    }
  });

  it("rejects a payload whose proof checks did not all pass, even if signed", async () => {
    const { signPayload } = await import("../src/attest.js");
    const env = keyEnvTdm109();
    const key = loadSigningKey(env);
    const att = signedTdm109(env);
    const forged = structuredClone(att) as unknown as {
      payload: { proof_checks: Record<string, { pass: boolean }> };
      signature: string;
    };
    forged.payload.proof_checks.no_secrets = { pass: false };
    forged.signature = signPayload(forged.payload as never, key);
    expect(verify(forged, wellKnownKeys(env))).toMatchObject({ valid: false, code: "schema" });
  });

  it("verifies an old attestation after rotation and fails with a foreign or unknown key", () => {
    const old = keyEnvTdm109("ab-2026-10");
    const att = signedTdm109(old);
    const cur = keyEnvTdm109("ab-2026-11");
    const rotated = wellKnownKeys({
      ...cur,
      PUBLISH_SIGNING_PREVIOUS_PUBLIC_KEYS: `ab-2026-10:${old.PUBLISH_SIGNING_PUBLIC_KEY_DER_B64}`,
    });
    expect(verify(att, rotated)).toMatchObject({ valid: true, key: { status: "previous" } });
    expect(verify(att, wellKnownKeys(cur))).toMatchObject({ valid: false, code: "unknown_key" });
    // Same key id, different key: an impostor keyset.
    const impostor = wellKnownKeys(keyEnvTdm109("ab-2026-10"));
    expect(verify(att, impostor)).toMatchObject({ valid: false, code: "bad_signature" });
    expect(verify(att, { keys: "nope" })).toMatchObject({ valid: false, code: "bad_keyset" });
  });

  it("rejects non-canonical text even when it parses to the same value", () => {
    const env = keyEnvTdm109();
    const att = signedTdm109(env);
    const keys = wellKnownKeys(env);
    expect(verify(JSON.stringify(att, null, 2), keys)).toMatchObject({
      valid: false,
      code: "not_canonical",
    });
    expect(verify("{not json", keys)).toMatchObject({ valid: false, code: "malformed" });
  });
});
