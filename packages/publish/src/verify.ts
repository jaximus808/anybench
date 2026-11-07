// TDM-109 [12.1]: verify a signed attestation against the published keyset
// (`/.well-known/anybench-keys.json`). Used by `anybench verify <url>` and the public page.
//
// Never throws: every failure is `{valid: false, code, reason}`. Text input (string or bytes)
// must be exactly the canonical serialization (`serializeAttestation`), so a change to any
// single byte fails, including edits that would parse to the same value (`1e-7` → `1E-7`,
// reordered keys, added whitespace, a different base64 spelling of the signature).
import { verify as edVerify } from "node:crypto";
import {
  AttestationPayloadSchema,
  SignedAttestationSchema,
  type AttestationPayload,
  type SignedAttestation,
} from "./attest.js";
import { canonicalBytes, canonicalize } from "./canonical.js";
import {
  decodeStrictBase64,
  parsePublicKeyDerB64,
  WellKnownKeysSchema,
  type WellKnownKey,
  type WellKnownKeys,
} from "./keys.js";

export type VerifyFailureCode =
  | "malformed"
  | "not_canonical"
  | "schema"
  | "key_id_mismatch"
  | "bad_keyset"
  | "unknown_key"
  | "bad_signature";

export type VerifyResult =
  | {
      valid: true;
      reason: string;
      payload: AttestationPayload;
      key: Pick<WellKnownKey, "key_id" | "status">;
    }
  | { valid: false; code: VerifyFailureCode; reason: string };

/** The canonical text of a signed attestation: store and serve exactly this. */
export function serializeAttestation(att: SignedAttestation): string {
  return canonicalize(att);
}

const fail = (code: VerifyFailureCode, reason: string): VerifyResult => ({
  valid: false,
  code,
  reason,
});

const ED25519_SIGNATURE_BYTES = 64;

/**
 * Check `attestation` (a parsed object, its canonical JSON text, or that text's UTF-8 bytes)
 * against `keyset` (the well-known keys document).
 */
export function verify(attestation: unknown, keyset: WellKnownKeys): VerifyResult;
export function verify(attestation: unknown, keyset: unknown): VerifyResult;
export function verify(attestation: unknown, keyset: unknown): VerifyResult {
  let value: unknown = attestation;
  if (attestation instanceof Uint8Array) {
    try {
      value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(attestation);
    } catch {
      return fail("malformed", "attestation is not valid UTF-8");
    }
  }
  if (typeof value === "string") {
    const text = value;
    try {
      value = JSON.parse(text);
    } catch {
      return fail("malformed", "attestation is not valid JSON");
    }
    let canon: string;
    try {
      canon = canonicalize(value);
    } catch {
      return fail("malformed", "attestation is not representable as canonical JSON");
    }
    if (canon !== text) return fail("not_canonical", "attestation text is not canonical JSON");
  }

  const env = SignedAttestationSchema.safeParse(value);
  if (!env.success) return fail("schema", `envelope: ${env.error.issues[0]!.message}`);
  const payload = AttestationPayloadSchema.safeParse(env.data.payload);
  if (!payload.success) {
    const i = payload.error.issues[0]!;
    return fail("schema", `payload ${i.path.join(".") || "(root)"}: ${i.message}`);
  }
  if (payload.data.key_id !== env.data.key_id)
    return fail("key_id_mismatch", "payload key_id differs from the envelope key_id");

  const ks = WellKnownKeysSchema.safeParse(keyset);
  if (!ks.success) return fail("bad_keyset", `keyset: ${ks.error.issues[0]!.message}`);
  const entry = ks.data.keys.find((k) => k.key_id === env.data.key_id);
  if (!entry) return fail("unknown_key", `key id ${env.data.key_id} is not in the keyset`);
  let publicKey;
  try {
    publicKey = parsePublicKeyDerB64(entry.public_key_spki_der_b64, `key ${entry.key_id}`);
  } catch (e) {
    return fail("bad_keyset", (e as Error).message);
  }

  const sig = decodeStrictBase64(env.data.signature);
  if (!sig || sig.length !== ED25519_SIGNATURE_BYTES)
    return fail("bad_signature", "signature is not 64 bytes of standard base64");

  let bytes: Uint8Array;
  try {
    // Sign-side canonicalization of the payload exactly as received (not a re-parsed copy).
    bytes = canonicalBytes(env.data.payload);
  } catch {
    return fail("malformed", "payload is not representable as canonical JSON");
  }
  if (!edVerify(null, bytes, publicKey, sig))
    return fail("bad_signature", "signature does not match the payload");

  return {
    valid: true,
    reason: `signed by ${entry.key_id} (${entry.status})`,
    payload: payload.data,
    key: { key_id: entry.key_id, status: entry.status },
  };
}
