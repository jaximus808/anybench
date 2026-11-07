// TDM-109 [12.1]: Ed25519 signing keys from env, and the public keyset served at
// `/.well-known/anybench-keys.json` (plan.md P5).
//
// Env (see .env.example):
//   PUBLISH_SIGNING_KEY_ID               current key id, e.g. `ab-2026-11`
//   PUBLISH_SIGNING_PRIVATE_KEY_DER_B64  pkcs8 DER, base64 (only the signer needs it)
//   PUBLISH_SIGNING_PUBLIC_KEY_DER_B64   spki DER, base64
//   PUBLISH_SIGNING_PREVIOUS_PUBLIC_KEYS rotated-out keys that still verify old attestations:
//                                        comma-separated `key_id:spki_der_b64` pairs
//
// Rotation: generate a new pair, move the old `id:public` into PREVIOUS, set the new one as
// current. Old attestations keep verifying because their key id stays in the keyset.
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { z } from "zod";

export const WELL_KNOWN_KEYS_PATH = "/.well-known/anybench-keys.json";
/** Suggested Cache-Control for the well-known document (short, so rotation propagates). */
export const WELL_KNOWN_KEYS_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";
export const SIGNATURE_ALG = "Ed25519";

export const KeyIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, { message: "key id: 1-64 of [A-Za-z0-9._-]" });

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Strict standard base64: decoding then re-encoding gives the same text. */
export function decodeStrictBase64(s: string): Buffer | undefined {
  if (s.length === 0 || !B64_RE.test(s)) return undefined;
  const buf = Buffer.from(s, "base64");
  return buf.toString("base64") === s ? buf : undefined;
}

export type PublishKeyErrorCode = "missing" | "invalid" | "mismatch" | "duplicate";

export class PublishKeyError extends Error {
  override readonly name = "PublishKeyError";
  constructor(
    readonly code: PublishKeyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SigningKey {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

type Env = Readonly<Record<string, string | undefined>>;

function need(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new PublishKeyError("missing", `${name} is not set`);
  return v;
}

function keyId(raw: string, what: string): string {
  const r = KeyIdSchema.safeParse(raw);
  if (!r.success) throw new PublishKeyError("invalid", `${what}: ${r.error.issues[0]!.message}`);
  return r.data;
}

/** Parse an spki DER base64 Ed25519 public key. */
export function parsePublicKeyDerB64(b64: string, what = "public key"): KeyObject {
  const der = decodeStrictBase64(b64);
  if (!der) throw new PublishKeyError("invalid", `${what}: not base64`);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new PublishKeyError("invalid", `${what}: not an spki DER public key`);
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new PublishKeyError("invalid", `${what}: ${key.asymmetricKeyType} is not Ed25519`);
  return key;
}

function parsePrivateKeyDerB64(b64: string, what: string): KeyObject {
  const der = decodeStrictBase64(b64);
  if (!der) throw new PublishKeyError("invalid", `${what}: not base64`);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new PublishKeyError("invalid", `${what}: not a pkcs8 DER private key`);
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new PublishKeyError("invalid", `${what}: ${key.asymmetricKeyType} is not Ed25519`);
  return key;
}

const spkiB64 = (k: KeyObject) => k.export({ format: "der", type: "spki" }).toString("base64");

/**
 * The current signing key from env. Throws PublishKeyError if a variable is missing or
 * malformed, or if the public key is not the private key's half.
 */
export function loadSigningKey(env: Env = process.env): SigningKey {
  const id = keyId(need(env, "PUBLISH_SIGNING_KEY_ID"), "PUBLISH_SIGNING_KEY_ID");
  const privateKey = parsePrivateKeyDerB64(
    need(env, "PUBLISH_SIGNING_PRIVATE_KEY_DER_B64"),
    "PUBLISH_SIGNING_PRIVATE_KEY_DER_B64",
  );
  const publicKey = parsePublicKeyDerB64(
    need(env, "PUBLISH_SIGNING_PUBLIC_KEY_DER_B64"),
    "PUBLISH_SIGNING_PUBLIC_KEY_DER_B64",
  );
  if (spkiB64(createPublicKey(privateKey)) !== spkiB64(publicKey)) {
    throw new PublishKeyError(
      "mismatch",
      "PUBLISH_SIGNING_PUBLIC_KEY_DER_B64 is not the public half of PUBLISH_SIGNING_PRIVATE_KEY_DER_B64",
    );
  }
  return { keyId: id, privateKey, publicKey };
}

export const WellKnownKeySchema = z.strictObject({
  key_id: KeyIdSchema,
  alg: z.literal(SIGNATURE_ALG),
  status: z.enum(["current", "previous"]),
  /** spki DER, standard base64. */
  public_key_spki_der_b64: z.string().min(1),
  /** The same key as an RFC 8037 OKP JWK, for verifiers that prefer JOSE. */
  jwk: z.strictObject({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().min(1) }),
});
export type WellKnownKey = z.infer<typeof WellKnownKeySchema>;

export const WellKnownKeysSchema = z.strictObject({
  issuer: z.literal("anybench"),
  keys: z
    .array(WellKnownKeySchema)
    .min(1)
    .refine((ks) => new Set(ks.map((k) => k.key_id)).size === ks.length, {
      message: "duplicate key_id in keyset",
    }),
});
/** The `/.well-known/anybench-keys.json` document. Also what `verify()` takes as a keyset. */
export type WellKnownKeys = z.infer<typeof WellKnownKeysSchema>;

function wellKnownEntry(id: string, key: KeyObject, status: WellKnownKey["status"]): WellKnownKey {
  const jwk = key.export({ format: "jwk" });
  return {
    key_id: id,
    alg: SIGNATURE_ALG,
    status,
    public_key_spki_der_b64: spkiB64(key),
    jwk: { kty: "OKP", crv: "Ed25519", x: String(jwk.x) },
  };
}

/**
 * Route handler body for `GET /.well-known/anybench-keys.json`, as a pure function of env.
 * Current key first, then each previous key. Reads public keys only (never the private key).
 * Throws PublishKeyError on missing or malformed config, or a duplicated key id.
 */
export function wellKnownKeys(env: Env = process.env): WellKnownKeys {
  const currentId = keyId(need(env, "PUBLISH_SIGNING_KEY_ID"), "PUBLISH_SIGNING_KEY_ID");
  const keys: WellKnownKey[] = [
    wellKnownEntry(
      currentId,
      parsePublicKeyDerB64(
        need(env, "PUBLISH_SIGNING_PUBLIC_KEY_DER_B64"),
        "PUBLISH_SIGNING_PUBLIC_KEY_DER_B64",
      ),
      "current",
    ),
  ];
  const previous = env.PUBLISH_SIGNING_PREVIOUS_PUBLIC_KEYS?.trim();
  if (previous) {
    for (const pair of previous.split(",")) {
      const item = pair.trim();
      if (item === "") continue;
      const colon = item.indexOf(":");
      if (colon <= 0)
        throw new PublishKeyError(
          "invalid",
          "PUBLISH_SIGNING_PREVIOUS_PUBLIC_KEYS: expected `key_id:spki_der_b64` pairs",
        );
      const id = keyId(item.slice(0, colon), "PUBLISH_SIGNING_PREVIOUS_PUBLIC_KEYS key id");
      if (keys.some((k) => k.key_id === id))
        throw new PublishKeyError("duplicate", `key id ${id} appears more than once`);
      const key = parsePublicKeyDerB64(
        item.slice(colon + 1),
        `PUBLISH_SIGNING_PREVIOUS_PUBLIC_KEYS ${id}`,
      );
      keys.push(wellKnownEntry(id, key, "previous"));
    }
  }
  return { issuer: "anybench", keys };
}
