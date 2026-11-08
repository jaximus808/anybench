// Publish worktree: signDocument / verifyDocument round trip and tamper checks. Throwaway keys.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  loadSigningKey,
  serializeDocument,
  signDocument,
  verifyDocument,
  wellKnownKeys,
} from "../src/index.js";

function envPublish(keyId = "ab-doc-1") {
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

describe("signDocument / verifyDocument", () => {
  const env = envPublish();
  const key = loadSigningKey(env);
  const keys = wellKnownKeys(env);
  const doc = signDocument({ b: 2, a: { verdict: "no detectable difference", p: 0.7 } }, key);

  it("verifies an object and its canonical text", () => {
    expect(verifyDocument(doc, keys)).toMatchObject({ valid: true, key: { key_id: "ab-doc-1" } });
    expect(verifyDocument(serializeDocument(doc), keys).valid).toBe(true);
  });

  it("fails on a changed payload, non-canonical text, another key and garbage", () => {
    const tampered = { ...doc, payload: { ...doc.payload, b: 3 } };
    expect(verifyDocument(tampered, keys)).toMatchObject({ valid: false, code: "bad_signature" });
    expect(verifyDocument(JSON.stringify(doc, null, 2), keys)).toMatchObject({
      valid: false,
      code: "not_canonical",
    });
    expect(verifyDocument(doc, wellKnownKeys(envPublish("ab-doc-1")))).toMatchObject({
      valid: false,
      code: "bad_signature",
    });
    expect(verifyDocument({ ...doc, key_id: "nope" }, keys)).toMatchObject({
      code: "unknown_key",
    });
    expect(verifyDocument("{", keys)).toMatchObject({ code: "malformed" });
    expect(verifyDocument(null, keys)).toMatchObject({ code: "malformed" });
  });
});
