// TDM-219 [19.3] / TDM-220 [19.4]: push a kit folder to Anybench, shared by `anybench kit push`
// and the MCP server's push_kit tool. Validate locally (an invalid kit is never uploaded), pack
// (packKit: the same path / link / size rules the upload API enforces), then the kit upload API
// (TDM-217 [19.1]): POST /kits/uploads → presigned PUT → POST /kits/uploads/:id/complete.
// Anybench reruns the proof on its own computers before any run from the kit is billed.
import {
  describeApiError,
  type ApiClient,
  type FetchLike,
  type KitDetail,
  type KitIssueBody,
} from "@anybench/core";
import { KitArchiveError, packKit } from "./archive.js";
import { validateKitDir } from "./validate.js";

export interface PushKitApi {
  client: ApiClient;
  /** The fetch for the presigned PUT (the same one the client uses). */
  fetch: FetchLike;
}

export interface PushKitOptions {
  /** Progress lines (`packed …: 12 files, 3456 bytes`). */
  onLog?: (line: string) => void;
}

/** Where a push stopped: nothing was uploaded before `upload`; nothing was stored unless ok. */
export type PushKitStage = "validate" | "pack" | "upload" | "server" | "api";

export type PushKitResult =
  | {
      ok: true;
      dir: string;
      kit: KitDetail;
      upload_id: string;
      archive: { sha256: string; bytes: number; files: number };
      /** Server-side warnings, formatted `file:line: message`. */
      warnings: string[];
    }
  | {
      ok: false;
      dir: string;
      stage: PushKitStage;
      /** What went wrong, one line each (validator lines, the server's lines, the API error). */
      lines: string[];
      /** The server's refusal issues (stage `server`). */
      issues?: KitIssueBody[];
      upload_id?: string;
    };

export async function pushKit(
  dir: string,
  api: PushKitApi,
  opts: PushKitOptions = {},
): Promise<PushKitResult> {
  const v = await validateKitDir(dir);
  if (!v.ok) {
    return {
      ok: false,
      dir: v.dir,
      stage: "validate",
      lines: [
        ...v.lines,
        `${v.errors.length} error${v.errors.length === 1 ? "" : "s"} in ${v.dir}; nothing uploaded`,
      ],
    };
  }
  let packed;
  try {
    packed = await packKit(v.dir);
  } catch (e) {
    if (e instanceof KitArchiveError) {
      return {
        ok: false,
        dir: v.dir,
        stage: "pack",
        lines: [...e.problems.map((p) => `${p.path ?? v.dir}: ${p.message}`), e.message],
      };
    }
    throw e;
  }
  opts.onLog?.(
    `packed ${v.dir}: ${packed.files} files, ${packed.bytes.length} bytes (sha256 ${packed.sha256.slice(0, 12)})`,
  );

  let uploadId: string | undefined;
  try {
    const { upload, plan } = await api.client.kits.uploadsCreate({
      body: { size_bytes: packed.bytes.length, sha256: packed.sha256 },
    });
    uploadId = upload.id;
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
      return {
        ok: false,
        dir: v.dir,
        stage: "upload",
        upload_id: upload.id,
        lines: [`the upload PUT failed (HTTP ${put.status}) ${text.slice(0, 300)}`.trimEnd()],
      };
    }
    const done = await api.client.kits.uploadsComplete({ params: { id: upload.id } });
    if (!done.ok) {
      return {
        ok: false,
        dir: v.dir,
        stage: "server",
        upload_id: upload.id,
        issues: done.issues,
        lines: [
          ...done.lines,
          `the server refused the kit (${done.issues.length} issue(s)); nothing stored`,
        ],
      };
    }
    return {
      ok: true,
      dir: v.dir,
      kit: done.kit,
      upload_id: upload.id,
      archive: { sha256: packed.sha256, bytes: packed.bytes.length, files: packed.files },
      warnings: done.warnings.map((w) => `${w.file}${w.line ? `:${w.line}` : ""}: ${w.message}`),
    };
  } catch (e) {
    return {
      ok: false,
      dir: v.dir,
      stage: "api",
      lines: describeApiError(e),
      ...(uploadId !== undefined ? { upload_id: uploadId } : {}),
    };
  }
}
