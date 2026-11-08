// Sign and verify any JSON document with the publish key (12.1): the publication snapshot of a
// delivered run (`anybench.publication/v1`, core PublicationSchema) uses this. Same envelope and
// canonical JSON as attest.ts, but schema-agnostic: the caller validates the payload's shape.
//
// verifyDocument never throws. Text input must be exactly `serializeDocument(...)`: one changed
// byte, reordered keys or added whitespace fails.
import { sign, verify as edVerify } from "node:crypto";
import { canonicalBytes, canonicalize } from "./canonical.js";
import {
  decodeStrictBase64,
  parsePublicKeyDerB64,
  SIGNATURE_ALG,
  WellKnownKeysSchema,
  type SigningKey,
  type WellKnownKey,
} from "./keys.js";

export interface SignedDocument<T> {
  payload: T;
  alg: typeof SIGNATURE_ALG;
  key_id: string;
  /** Ed25519 over `canonicalBytes(payload)`, standard base64. */
  signature: string;
}

export function signDocument<T>(payload: T, key: SigningKey): SignedDocument<T> {
  const signature = sign(null, canonicalBytes(payload), key.privateKey).toString("base64");
  return { payload, alg: SIGNATURE_ALG, key_id: key.keyId, signature };
}

/** The canonical text of a signed document: store and serve exactly this. */
export function serializeDocument(doc: SignedDocument<unknown>): string {
  return canonicalize(doc);
}

export type DocumentVerifyResult =
  | { valid: true; reason: string; payload: unknown; key: Pick<WellKnownKey, "key_id" | "status"> }
  | {
      valid: false;
      code: "malformed" | "not_canonical" | "bad_keyset" | "unknown_key" | "bad_signature";
      reason: string;
    };

export function verifyDocument(doc: unknown, keyset: unknown): DocumentVerifyResult {
  try {
    return verifyUnguarded(doc, keyset);
  } catch {
    return { valid: false, code: "malformed", reason: "document could not be inspected" };
  }
}

function verifyUnguarded(doc: unknown, keyset: unknown): DocumentVerifyResult {
  let value = doc;
  if (doc instanceof Uint8Array) value = new TextDecoder("utf-8", { fatal: true }).decode(doc);
  if (typeof value === "string") {
    const text = value;
    try {
      value = JSON.parse(text);
    } catch {
      return { valid: false, code: "malformed", reason: "document is not valid JSON" };
    }
    if (canonicalize(value) !== text)
      return { valid: false, code: "not_canonical", reason: "document text is not canonical JSON" };
  }
  if (typeof value !== "object" || value === null)
    return { valid: false, code: "malformed", reason: "document is not an object" };
  const env = value as Record<string, unknown>;
  if (
    env.alg !== SIGNATURE_ALG ||
    typeof env.key_id !== "string" ||
    typeof env.signature !== "string" ||
    !("payload" in env)
  )
    return {
      valid: false,
      code: "malformed",
      reason: "expected {payload, alg: Ed25519, key_id, signature}",
    };
  const ks = WellKnownKeysSchema.safeParse(keyset);
  if (!ks.success)
    return { valid: false, code: "bad_keyset", reason: `keyset: ${ks.error.issues[0]!.message}` };
  const entry = ks.data.keys.find((k) => k.key_id === env.key_id);
  if (!entry)
    return {
      valid: false,
      code: "unknown_key",
      reason: `key id ${env.key_id} is not in the keyset`,
    };
  let publicKey;
  try {
    publicKey = parsePublicKeyDerB64(entry.public_key_spki_der_b64, `key ${entry.key_id}`);
  } catch (e) {
    return { valid: false, code: "bad_keyset", reason: (e as Error).message };
  }
  const sig = decodeStrictBase64(env.signature);
  if (!sig || sig.length !== 64)
    return {
      valid: false,
      code: "bad_signature",
      reason: "signature is not 64 bytes of standard base64",
    };
  if (!edVerify(null, canonicalBytes(env.payload), publicKey, sig))
    return { valid: false, code: "bad_signature", reason: "signature does not match the payload" };
  return {
    valid: true,
    reason: `signed by ${entry.key_id} (${entry.status})`,
    payload: env.payload,
    key: { key_id: entry.key_id, status: entry.status },
  };
}
