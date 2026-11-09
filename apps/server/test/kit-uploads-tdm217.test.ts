// TDM-217 [19.1]: kit upload routes against local Postgres (skips without it), with an in-memory
// presigned store. Successes go through the typed core client (each response is parsed with the
// contract's schema); errors are checked against ApiErrorBody.
import { fileURLToPath } from "node:url";
import {
  ApiClientError,
  ApiErrorBodySchema,
  createApiClient,
  KIT_UPLOAD_LIMITS,
  type ApiClient,
} from "@anybench/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kits } from "../src/db/schema/index.js";
import {
  dirEntriesTdm217,
  fakeKitStoreTdm217,
  sha256Tdm217,
  tgzTdm217,
  type TarEntryTdm217,
} from "./helpers/kit-upload-tdm217.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import {
  runsAppTdm67,
  seedApiKeyTdm67,
  seedUserTdm67,
  type RunsAppTdm67,
} from "./helpers/runs-tdm67.js";

const available = await pgAvailableTdm11();
const BASE = "http://api.test";
const TANDEM_KIT = fileURLToPath(new URL("../../../kits/tandem-vs-claude-code", import.meta.url));

async function expectApiError(p: Promise<unknown>, status: number, code?: string) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiClientError);
    const e = err as ApiClientError;
    expect(e.status, e.message).toBe(status);
    expect(ApiErrorBodySchema.safeParse(e.body).success).toBe(true);
    if (code) expect(e.code).toBe(code);
    return e;
  }
  throw new Error(`expected HTTP ${status}`);
}

describe.skipIf(!available)("kit upload routes (TDM-217)", () => {
  let db: FreshDbTdm11;
  let h: RunsAppTdm67;
  let noStore: RunsAppTdm67;
  const store = fakeKitStoreTdm217();
  let alice: string;
  let bob: string;
  let a: ApiClient;
  let b: ApiClient;
  const clientFor = (app: RunsAppTdm67, bearer: string): ApiClient =>
    createApiClient(
      BASE,
      { kind: "apiKey", key: bearer },
      { fetch: (url, init) => Promise.resolve(app.app.request(url, init)) },
    );

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    h = runsAppTdm67(db.url, { deps: { kitFiles: store } });
    noStore = runsAppTdm67(db.url);
    alice = await seedUserTdm67(db.db, "alice217");
    bob = await seedUserTdm67(db.db, "bob217");
    a = clientFor(h, alice);
    b = clientFor(h, bob);
  }, 60_000);

  afterAll(async () => {
    await h?.dbh.close();
    await noStore?.dbh.close();
    await db?.drop();
  });

  /** create → PUT → complete, as the CLI does it. */
  async function upload(client: ApiClient, tgz: Uint8Array) {
    const created = await client.kits.uploadsCreate({
      body: { size_bytes: tgz.byteLength, sha256: sha256Tdm217(tgz) },
    });
    expect(store.put(created.plan.url, created.plan.headers, tgz)).toBe(200);
    return { id: created.upload.id, created };
  }

  const tandemTgz = () => tgzTdm217(dirEntriesTdm217(TANDEM_KIT, "tandem-vs-claude-code"));

  it("a valid upload creates an unproven `uploaded` kit owned by the caller, with no run", async () => {
    const tgz = tandemTgz();
    const { id, created } = await upload(a, tgz);
    expect(created.upload).toMatchObject({
      size_bytes: tgz.byteLength,
      sha256: sha256Tdm217(tgz),
      content_type: "application/gzip",
    });
    expect(created.plan.headers["content-length"]).toBe(String(tgz.byteLength));

    const done = await a.kits.uploadsComplete({ params: { id } });
    if (!done.ok) throw new Error(done.lines.join("\n"));
    const kit = done.kit;
    expect(kit).toMatchObject({ run_id: null, origin: "uploaded", version: 1, proven: false });
    expect(kit.proof).toEqual([]);
    expect(kit.spec.subject.name).toBeTruthy();

    const [row] = await db.db.select().from(kits).where(eq(kits.id, kit.id));
    expect(row).toMatchObject({ ownerId: alice, runId: null, origin: "uploaded", uploadId: id });
    expect(row!.filesUrl).toBe(`artifact:kits/files/${alice}/${kit.id}.tar.gz`);
    // The validated bytes are stored server-side; the user-writable upload object is gone.
    expect(store.objects.get(`kits/files/${alice}/${kit.id}.tar.gz`)).toEqual(new Uint8Array(tgz));
    expect(store.objects.has(`kits/uploads/${alice}/${id}.tar.gz`)).toBe(false);

    // Readable, listed and downloadable by the owner.
    expect((await a.kits.get({ params: { id: kit.id } })).kit.id).toBe(kit.id);
    expect((await a.kits.list({ query: {} })).items.map((k) => k.id)).toContain(kit.id);
    const dl = await a.kits.download({ params: { id: kit.id } });
    expect(dl.url).toContain(`kits/files/${alice}/${kit.id}.tar.gz`);

    // Completing again returns the same kit (idempotent), not a second row.
    const again = await a.kits.uploadsComplete({ params: { id } });
    expect(again.ok && again.kit.id).toBe(kit.id);
    expect(await db.db.select().from(kits).where(eq(kits.uploadId, id))).toHaveLength(1);

    // An uploaded kit has no run to version.
    await expectApiError(
      a.kits.createVersion({ params: { id: kit.id }, body: { spec: kit.spec } }),
      409,
      "conflict",
    );
  });

  it("an invalid kit returns its schema issues and stores nothing", async () => {
    const tgz = tgzTdm217([
      { name: "anybench.yaml", data: "schema_version: 2\nsubject:\n  kind: software\n" },
    ]);
    const { id } = await upload(a, tgz);
    const done = await a.kits.uploadsComplete({ params: { id } });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.issues.length).toBeGreaterThan(0);
    expect(done.issues.every((i) => i.severity === "error")).toBe(true);
    expect(done.issues.some((i) => i.code === "schema" && i.file === "anybench.yaml")).toBe(true);
    expect(done.lines[0]).toMatch(/^anybench\.yaml/);
    expect(await db.db.select().from(kits).where(eq(kits.uploadId, id))).toHaveLength(0);
    expect(store.objects.has(`kits/uploads/${alice}/${id}.tar.gz`)).toBe(false);
  });

  it("a missing manifest is an issue too", async () => {
    const { id } = await upload(a, tgzTdm217([{ name: "README.md", data: "no kit here" }]));
    const done = await a.kits.uploadsComplete({ params: { id } });
    expect(done.ok === false && done.issues.map((i) => i.code)).toEqual(["manifest_missing"]);
  });

  const hostile: [string, TarEntryTdm217[]][] = [
    ["a ../ path", [{ name: "../../etc/cron.d/evil", data: "* * * * * root sh" }]],
    ["an absolute path", [{ name: "/etc/passwd", data: "root::0:0" }]],
    ["a symlink", [{ name: "gates/g/check.sh", type: "2", linkname: "/etc/passwd" }]],
    ["a hardlink", [{ name: "steal", type: "1", linkname: "/etc/shadow" }]],
    ["a device", [{ name: "dev", type: "3" }]],
  ];
  it.each(hostile)("a tar with %s is refused (400) and nothing is written", async (_, extra) => {
    const base = dirEntriesTdm217(TANDEM_KIT);
    const { id } = await upload(a, tgzTdm217([...base, ...extra]));
    const e = await expectApiError(
      a.kits.uploadsComplete({ params: { id } }),
      400,
      "validation_failed",
    );
    const body = ApiErrorBodySchema.parse(e.body);
    expect(body.error.issues?.[0]).toMatch(/^archive: /);
    expect(await db.db.select().from(kits).where(eq(kits.uploadId, id))).toHaveLength(0);
    expect(store.objects.has(`kits/uploads/${alice}/${id}.tar.gz`)).toBe(false);
  });

  it("over-size: refused at create (413), and a stored object over the cap at complete (413)", async () => {
    await expectApiError(
      a.kits.uploadsCreate({
        body: { size_bytes: KIT_UPLOAD_LIMITS.maxBytes + 1, sha256: "a".repeat(64) },
      }),
      413,
      "payload_too_large",
    );
    // A store holding more than was signed (it never should) is still capped on read.
    const { id } = await upload(a, tgzTdm217([{ name: "anybench.yaml", data: "x" }]));
    store.objects.set(
      `kits/uploads/${alice}/${id}.tar.gz`,
      new Uint8Array(KIT_UPLOAD_LIMITS.maxBytes + 1),
    );
    await expectApiError(a.kits.uploadsComplete({ params: { id } }), 413, "payload_too_large");
    // A PUT of other bytes than were signed is refused by the store itself.
    const tgz = tgzTdm217([{ name: "anybench.yaml", data: "y" }]);
    const c = await a.kits.uploadsCreate({
      body: { size_bytes: tgz.byteLength, sha256: sha256Tdm217(tgz) },
    });
    expect(store.put(c.plan.url, c.plan.headers, Buffer.concat([tgz, Buffer.from("more")]))).toBe(
      403,
    );
  });

  it("a gzip bomb is refused (413)", async () => {
    // 210 MiB of zeros gzips to ~200 KiB: under the upload cap, over the unpacked cap.
    const bomb = tgzTdm217([
      { name: "anybench.yaml", data: "x" },
      { name: "zeros", data: Buffer.alloc(KIT_UPLOAD_LIMITS.maxUnpackedBytes + 10 * 1024 * 1024) },
    ]);
    expect(bomb.byteLength).toBeLessThan(KIT_UPLOAD_LIMITS.maxBytes);
    const { id } = await upload(a, bomb);
    await expectApiError(a.kits.uploadsComplete({ params: { id } }), 413, "payload_too_large");
  }, 60_000);

  it("another user's upload and kit ids are 404", async () => {
    const { id } = await upload(a, tandemTgz());
    await expectApiError(b.kits.uploadsComplete({ params: { id } }), 404, "not_found");
    const done = await a.kits.uploadsComplete({ params: { id } });
    if (!done.ok) throw new Error("expected a kit");
    await expectApiError(b.kits.get({ params: { id: done.kit.id } }), 404, "not_found");
    await expectApiError(b.kits.download({ params: { id: done.kit.id } }), 404, "not_found");
    // Bob completing Alice's (already completed) upload id still finds nothing of his.
    await expectApiError(b.kits.uploadsComplete({ params: { id } }), 404, "not_found");
    expect((await b.kits.list({ query: {} })).items).toEqual([]);
    // An unknown upload id.
    await expectApiError(
      a.kits.uploadsComplete({ params: { id: "0190f0f0-0000-7000-8000-000000000000" } }),
      404,
      "not_found",
    );
  });

  it("API keys: uploads need runs:write; a run-limited key can neither upload nor see uploads", async () => {
    const reader = clientFor(h, await seedApiKeyTdm67(db.db, alice, ["runs:read"]));
    await expectApiError(
      reader.kits.uploadsCreate({ body: { size_bytes: 10, sha256: "a".repeat(64) } }),
      403,
      "forbidden",
    );
    const limited = clientFor(
      h,
      await seedApiKeyTdm67(db.db, alice, ["runs:read", "runs:write"], []),
    );
    await expectApiError(
      limited.kits.uploadsCreate({ body: { size_bytes: 10, sha256: "a".repeat(64) } }),
      403,
      "forbidden",
    );
    const [mine] = await db.db.select().from(kits).where(eq(kits.ownerId, alice)).limit(1);
    await expectApiError(limited.kits.get({ params: { id: mine!.id } }), 403, "forbidden");
  });

  it("503 without an artifact store", async () => {
    const c = clientFor(noStore, alice);
    await expectApiError(
      c.kits.uploadsCreate({ body: { size_bytes: 10, sha256: "a".repeat(64) } }),
      503,
      "unavailable",
    );
  });
});
