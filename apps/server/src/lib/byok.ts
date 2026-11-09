// BYOK model keys (plan.md "Customer model keys", TDM-212): envelope encryption for user_secrets.
//
//   seal   a fresh random 32-byte data key (DEK) encrypts the secret with AES-256-GCM; the KEK
//          (ANYBENCH_KEK) wraps the DEK with AES-256-GCM. Both bind the owner and provider as
//          additional data, so a row copied to another owner or provider never decrypts.
//   open   unwrap the DEK with the KEK of the row's kek_version (1 = ANYBENCH_KEK, 0 =
//          ANYBENCH_KEK_PREVIOUS during a rotation), then decrypt.
//
// The KEK is derived as SHA-256 of the ANYBENCH_KEK string (any high-entropy value works; the
// .env.example recipe is `openssl rand -base64 32`). Values are base64 text in the table. The
// plaintext is decrypted only right before a trial and written to the trial computer's
// ~/.anybench/env (0600) by the executor; it is never logged and never returned by any route.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { userSecrets } from "../db/schema/user_secrets.js";
import { users } from "../db/schema/users.js";

/** user_secrets.provider for an Anthropic API key (AB_TOKEN_SOURCE=anthropic_key). */
export const ANTHROPIC_PROVIDER = "anthropic";
/** kek_version of a row sealed with ANYBENCH_KEK. */
export const CURRENT_KEK_VERSION = 1;
/** kek_version of a row still sealed with ANYBENCH_KEK_PREVIOUS (before a rotation's re-seal). */
export const PREVIOUS_KEK_VERSION = 0;

export interface KekSet {
  /** ANYBENCH_KEK. */
  current: string;
  /** ANYBENCH_KEK_PREVIOUS, during a rotation. */
  previous?: string | undefined;
}

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  wrappedDek: string;
  kekVersion: number;
  last4: string;
}

export class ByokError extends Error {
  override readonly name = "ByokError";
}

const kekBytes = (kek: string): Buffer => {
  if (kek.length < 32) throw new ByokError("ANYBENCH_KEK must be at least 32 characters");
  return createHash("sha256").update(kek, "utf8").digest();
};
const aad = (ownerId: string, provider: string, part: "dek" | "secret") =>
  Buffer.from(`anybench-byok:${part}:${ownerId}:${provider}`, "utf8");

function gcmSeal(key: Buffer, plaintext: Buffer, data: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(data);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}

function gcmOpen(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, data: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(data);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** Encrypt one secret for (owner, provider) under the current KEK. */
export function sealSecret(input: {
  kek: string;
  ownerId: string;
  provider: string;
  plaintext: string;
}): SealedSecret {
  if (input.plaintext.length < 8) throw new ByokError("the secret is too short to be a model key");
  const dek = randomBytes(32);
  const secret = gcmSeal(
    dek,
    Buffer.from(input.plaintext, "utf8"),
    aad(input.ownerId, input.provider, "secret"),
  );
  const wrap = gcmSeal(kekBytes(input.kek), dek, aad(input.ownerId, input.provider, "dek"));
  dek.fill(0);
  return {
    ciphertext: secret.ct.toString("base64"),
    iv: secret.iv.toString("base64"),
    tag: secret.tag.toString("base64"),
    wrappedDek: Buffer.concat([wrap.iv, wrap.tag, wrap.ct]).toString("base64"),
    kekVersion: CURRENT_KEK_VERSION,
    last4: input.plaintext.slice(-4),
  };
}

/** Decrypt a sealed secret. Throws ByokError when the KEK is wrong or the row was tampered with. */
export function openSecret(input: {
  keks: KekSet;
  ownerId: string;
  provider: string;
  sealed: Omit<SealedSecret, "last4">;
}): string {
  const { sealed } = input;
  const kek =
    sealed.kekVersion === CURRENT_KEK_VERSION
      ? input.keks.current
      : sealed.kekVersion === PREVIOUS_KEK_VERSION
        ? input.keks.previous
        : undefined;
  if (!kek) throw new ByokError(`no KEK for kek_version ${sealed.kekVersion}`);
  try {
    const w = Buffer.from(sealed.wrappedDek, "base64");
    const dek = gcmOpen(
      kekBytes(kek),
      w.subarray(0, 12),
      w.subarray(28),
      w.subarray(12, 28),
      aad(input.ownerId, input.provider, "dek"),
    );
    const out = gcmOpen(
      dek,
      Buffer.from(sealed.iv, "base64"),
      Buffer.from(sealed.ciphertext, "base64"),
      Buffer.from(sealed.tag, "base64"),
      aad(input.ownerId, input.provider, "secret"),
    );
    dek.fill(0);
    return out.toString("utf8");
  } catch (e) {
    if (e instanceof ByokError) throw e;
    throw new ByokError("the stored secret does not decrypt with this KEK");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The user a secret belongs to, by GitHub login or user id (scripts/ops/store-byok-key.ts). Here
 * rather than in the script so the drizzle operators resolve from apps/server's node_modules: the
 * repo root has no drizzle-orm (TDM-234).
 */
export async function findSecretOwner(
  db: Database,
  owner: string,
): Promise<{ id: string; login: string } | null> {
  const [user] = await db
    .select({ id: users.id, login: users.githubLogin })
    .from(users)
    .where(
      UUID.test(owner)
        ? or(eq(users.id, owner), eq(users.githubLogin, owner))
        : eq(users.githubLogin, owner),
    )
    .limit(1);
  return user ?? null;
}

/** Insert or replace the owner's secret for a provider. Returns its last 4 characters. */
export async function storeUserSecret(
  db: Database,
  input: { kek: string; ownerId: string; provider: string; plaintext: string },
): Promise<{ last4: string }> {
  const sealed = sealSecret(input);
  await db
    .insert(userSecrets)
    .values({ ownerId: input.ownerId, provider: input.provider, ...sealed })
    .onConflictDoUpdate({
      target: [userSecrets.ownerId, userSecrets.provider],
      set: { ...sealed, updatedAt: new Date() },
    });
  return { last4: sealed.last4 };
}

/** The owner's decrypted secret for a provider (and stamp last_used_at), or null when none. */
export async function loadUserSecret(
  db: Database,
  keks: KekSet,
  ownerId: string,
  provider: string,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(userSecrets)
    .where(and(eq(userSecrets.ownerId, ownerId), eq(userSecrets.provider, provider)))
    .limit(1);
  if (!row) return null;
  const value = openSecret({ keks, ownerId, provider, sealed: row });
  await db.update(userSecrets).set({ lastUsedAt: new Date() }).where(eq(userSecrets.id, row.id));
  return value;
}

/** A run owner's key lookup for the trial source, or undefined when no KEK is configured. */
export type ByokLookup = (ownerId: string, provider: string) => Promise<string | null>;

export function byokLookup(
  db: Database,
  keks: { current?: string | undefined; previous?: string | undefined },
): ByokLookup | undefined {
  const current = keks.current;
  if (!current) return undefined;
  return (ownerId, provider) =>
    loadUserSecret(db, { current, previous: keks.previous }, ownerId, provider);
}
