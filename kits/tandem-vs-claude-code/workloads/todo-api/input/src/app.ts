import { createServer, type Server } from "node:http";
import { HttpError, sendError, sendJson } from "./http.ts";
import { Router } from "./router.ts";

export interface AppOptions {
  /** Where to persist state as JSON. Omit to keep everything in memory. */
  dataFile?: string;
}

export function createApp(_options: AppOptions = {}): Server {
  const router = new Router();

  router.add("GET", "/health", ({ res }) => sendJson(res, 200, { ok: true }));

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const found = router.match(req.method ?? "GET", url.pathname);
    if (found === undefined) {
      sendError(res, new HttpError(404, "not_found", `no route for ${req.method} ${url.pathname}`));
      return;
    }
    // Run sync and async handlers alike, so a thrown HttpError always becomes a response.
    const ctx = { req, res, params: found.params, query: url.searchParams };
    Promise.resolve()
      .then(() => found.handler(ctx))
      .catch((err: unknown) => {
        if (err instanceof HttpError) sendError(res, err);
        else {
          console.error(err);
          sendError(res, new HttpError(500, "internal", "internal error"));
        }
      });
  });
}
