// `anybench kit push [dir]` (TDM-219 [19.3]): validate the kit, pack it (@anybench/kit packKit:
// the same path / link / size rules the upload API enforces), upload it through the kit upload API
// (TDM-217 [19.1]: POST /kits/uploads → presigned PUT → POST /kits/uploads/:id/complete) and print
// the kit id. Anybench reruns the proof on its own computers before any run from it is billed.
//
// stdout is the kit id alone (or the JSON result with --json), so `KIT=$(anybench kit push)` works.
// Exit codes: 0 uploaded · 1 the kit is invalid or the API refused it · 2 usage or missing API key.
import { KitArchiveError, packKit, validateKitDir } from "@anybench/kit";
import { apiFromEnv, describeApiError, type ApiDeps } from "./api.js";
import { defaultIo, parseFlags, type CliIo } from "./args.js";

export const KIT_PUSH_USAGE = `Usage: anybench kit push [dir] [--json]

Validate the kit in [dir] (default: .), pack it as a .tar.gz and upload it to Anybench. Prints the
kit id; start a run from it with: anybench run --kit <kit_id> --question … --budget …
Anybench reruns the kit's proof on its own computers: an uploaded kit is never trusted as is.
Run \`anybench kit proof\` first to catch a broken oracle or gate for free.

Options:
  --json      print the result as JSON
  -h, --help

Env: ANYBENCH_API_KEY (required, scope runs:write), ANYBENCH_API_URL.`;

export async function runKitPush(
  argv: readonly string[],
  io: CliIo = defaultIo,
  deps: ApiDeps = {},
): Promise<number> {
  const a = parseFlags(argv, { booleans: ["json"] });
  if ("error" in a) {
    io.stderr(`anybench kit push: ${a.error}`);
    io.stderr(KIT_PUSH_USAGE);
    return 2;
  }
  if (a.booleans.has("help")) {
    io.stdout(KIT_PUSH_USAGE);
    return 0;
  }
  const api = apiFromEnv(deps);
  if ("error" in api) {
    io.stderr(`anybench kit push: ${api.error}`);
    return 2;
  }
  const json = a.booleans.has("json");
  const dir = a.positionals[0] ?? ".";

  const v = await validateKitDir(dir);
  if (!v.ok) {
    for (const l of v.lines) io.stderr(l);
    io.stderr(
      `${v.errors.length} error${v.errors.length === 1 ? "" : "s"} in ${v.dir}; nothing uploaded`,
    );
    return 1;
  }
  let packed;
  try {
    packed = await packKit(v.dir);
  } catch (e) {
    if (e instanceof KitArchiveError) {
      for (const p of e.problems) io.stderr(`${p.path ?? v.dir}: ${p.message}`);
      io.stderr(`anybench kit push: ${e.message}`);
      return 1;
    }
    throw e;
  }
  io.stderr(
    `packed ${v.dir}: ${packed.files} files, ${packed.bytes.length} bytes (sha256 ${packed.sha256.slice(0, 12)})`,
  );

  try {
    const { upload, plan } = await api.client.kits.uploadsCreate({
      body: { size_bytes: packed.bytes.length, sha256: packed.sha256 },
    });
    // Every plan header as given (R2 checks the length and the sha256 it was signed for),
    // except content-length: fetch sets it from the body, and some runtimes refuse it twice.
    const put = await api.fetch(plan.url, {
      method: plan.method,
      headers: Object.fromEntries(
        Object.entries(plan.headers).filter(([k]) => k.toLowerCase() !== "content-length"),
      ),
      body: packed.bytes,
    });
    if (!put.ok) {
      const text = await put.text().catch(() => "");
      io.stderr(
        `anybench kit push: the upload PUT failed (HTTP ${put.status}) ${text.slice(0, 300)}`,
      );
      return 1;
    }
    const done = await api.client.kits.uploadsComplete({ params: { id: upload.id } });
    if (!done.ok) {
      for (const l of done.lines) io.stderr(l);
      io.stderr(`the server refused the kit (${done.issues.length} issue(s)); nothing stored`);
      if (json)
        io.stdout(
          JSON.stringify({ ok: false, upload_id: upload.id, issues: done.issues }, null, 2),
        );
      return 1;
    }
    for (const w of done.warnings)
      io.stderr(`warning: ${w.file}${w.line ? `:${w.line}` : ""}: ${w.message}`);
    if (json) {
      io.stdout(
        JSON.stringify(
          {
            ok: true,
            kit_id: done.kit.id,
            name: done.kit.name,
            version: done.kit.version,
            hash: done.kit.hash,
            proven: done.kit.proven,
            upload_id: upload.id,
            archive_sha256: packed.sha256,
          },
          null,
          2,
        ),
      );
    } else {
      io.stderr(
        `uploaded kit '${done.kit.name}' (not yet proven: Anybench reruns the proof before the first run)`,
      );
      io.stderr(`next: anybench run --kit ${done.kit.id} --question "…" --budget 25`);
      io.stdout(done.kit.id);
    }
    return 0;
  } catch (e) {
    for (const l of describeApiError(e)) io.stderr(`anybench kit push: ${l}`);
    return 1;
  }
}
