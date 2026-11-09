// `anybench kit push [dir]` (TDM-219 [19.3]): validate the kit, pack it (@anybench/kit packKit:
// the same path / link / size rules the upload API enforces), upload it through the kit upload API
// (TDM-217 [19.1]: POST /kits/uploads → presigned PUT → POST /kits/uploads/:id/complete) and print
// the kit id. The flow is @anybench/kit pushKit, shared with the MCP push_kit tool (TDM-220). Anybench reruns the proof on its own computers before any run from it is billed.
//
// stdout is the kit id alone (or the JSON result with --json), so `KIT=$(anybench kit push)` works.
// Exit codes: 0 uploaded · 1 the kit is invalid or the API refused it · 2 usage or missing API key.
import { pushKit } from "@anybench/kit";
import { apiFromEnv, type ApiDeps } from "./api.js";
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

  const r = await pushKit(dir, api, { onLog: (l) => io.stderr(l) });
  if (!r.ok) {
    if (r.stage === "validate") {
      for (const l of r.lines) io.stderr(l);
    } else if (r.stage === "server") {
      for (const l of r.lines) io.stderr(l);
      if (json)
        io.stdout(JSON.stringify({ ok: false, upload_id: r.upload_id, issues: r.issues }, null, 2));
    } else {
      for (const l of r.lines) io.stderr(`anybench kit push: ${l}`);
    }
    return 1;
  }
  for (const w of r.warnings) io.stderr(`warning: ${w}`);
  if (json) {
    io.stdout(
      JSON.stringify(
        {
          ok: true,
          kit_id: r.kit.id,
          name: r.kit.name,
          version: r.kit.version,
          hash: r.kit.hash,
          proven: r.kit.proven,
          upload_id: r.upload_id,
          archive_sha256: r.archive.sha256,
        },
        null,
        2,
      ),
    );
  } else {
    io.stderr(
      `uploaded kit '${r.kit.name}' (not yet proven: Anybench reruns the proof before the first run)`,
    );
    io.stderr(`next: anybench run --kit ${r.kit.id} --question "…" --budget 25`);
    io.stdout(r.kit.id);
  }
  return 0;
}
