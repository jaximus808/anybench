import type { IncomingMessage, ServerResponse } from "node:http";

/** Every error response has this body: `{ error: { code, message } }`. */
export interface ErrorBody {
  error: { code: string; message: string };
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

export function sendError(res: ServerResponse, err: HttpError): void {
  const body: ErrorBody = { error: { code: err.code, message: err.message } };
  sendJson(res, err.status, body);
}

export const MAX_BODY_BYTES = 64 * 1024;

export interface RawBody {
  /** The body bytes, or null when the body was larger than MAX_BODY_BYTES. */
  buf: Buffer | null;
  size: number;
  aborted: boolean;
}

/**
 * Reads the whole request body. Bytes past MAX_BODY_BYTES are drained and dropped, so the
 * server can still answer 413 cleanly after the client finished sending.
 */
export function readRaw(req: IncomingMessage): Promise<RawBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let done = false;
    const finish = (aborted: boolean) => {
      if (done) return;
      done = true;
      resolve({ buf: tooLarge ? null : Buffer.concat(chunks), size, aborted });
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) return;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(false));
    req.on("error", () => finish(true));
    req.on("close", () => finish(!req.complete));
  });
}

export const errors = {
  notFound: (msg = "not found") => new HttpError(404, "not_found", msg),
  unauthorized: (msg = "authentication required") => new HttpError(401, "unauthorized", msg),
  forbidden: (msg = "your role does not allow this") => new HttpError(403, "forbidden", msg),
  invalidBody: (msg: string) => new HttpError(400, "invalid_body", msg),
  invalidQuery: (msg: string) => new HttpError(400, "invalid_query", msg),
  conflict: (code: string, msg: string) => new HttpError(409, code, msg),
};
