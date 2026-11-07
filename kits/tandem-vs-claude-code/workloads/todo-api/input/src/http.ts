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

const MAX_BODY_BYTES = 64 * 1024;

/** Reads and parses a JSON body. Throws HttpError(400, "invalid_json") on bad input. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large", "body is too large");
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "body is not valid JSON");
  }
}
