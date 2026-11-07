import { requireUser } from "./auth.ts";
import { HttpError, readJson, sendEmpty, sendJson } from "./http.ts";
import type { Router } from "./router.ts";
import type { Store, Todo } from "./store.ts";
import { asObject, invalidBody, isDate, validTitle } from "./validate.ts";

export interface TodoView {
  id: string;
  title: string;
  done: boolean;
  due: string | null;
  createdAt: string;
}

function view(todo: Todo): TodoView {
  return { id: todo.id, title: todo.title, done: todo.done, due: todo.due, createdAt: todo.createdAt };
}

function notFound(): HttpError {
  return new HttpError(404, "not_found", "todo not found");
}

function invalidQuery(message: string): HttpError {
  return new HttpError(400, "invalid_query", message);
}

function encodeCursor(seq: number): string {
  return Buffer.from(`s:${seq}`).toString("base64url");
}

function decodeCursor(cursor: string): number {
  const m = /^s:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (m === null) throw invalidQuery("cursor is not valid");
  return Number(m[1]);
}

function parseLimit(raw: string | null): number {
  if (raw === null) return 20;
  if (!/^\d+$/.test(raw)) throw invalidQuery("limit must be an integer from 1 to 100");
  const n = Number(raw);
  if (n < 1 || n > 100) throw invalidQuery("limit must be an integer from 1 to 100");
  return n;
}

function parseDone(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw invalidQuery("done must be true or false");
}

/** First index in the (seq-sorted) list whose seq is greater than `after`. */
function firstAfter(list: readonly Todo[], after: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.seq <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function addTodoRoutes(router: Router, store: Store): void {
  router.add("POST", "/todos", async ({ req, res }) => {
    const userId = requireUser(req, store);
    const body = asObject(await readJson(req));
    const title = validTitle(body.title);
    let due: string | null = null;
    if (body.due !== undefined && body.due !== null) {
      if (typeof body.due !== "string" || !isDate(body.due)) throw invalidBody("due must be a YYYY-MM-DD date");
      due = body.due;
    }
    sendJson(res, 201, view(store.addTodo(userId, title, due)));
  });

  router.add("GET", "/todos", ({ req, res, query }) => {
    const userId = requireUser(req, store);
    const limit = parseLimit(query.get("limit"));
    const done = parseDone(query.get("done"));
    const cursor = query.get("cursor");
    const list = store.todosOf(userId);
    const items: TodoView[] = [];
    let i = cursor === null ? 0 : firstAfter(list, decodeCursor(cursor));
    let last: Todo | undefined;
    for (; i < list.length && items.length < limit; i++) {
      const todo = list[i]!;
      if (done !== undefined && todo.done !== done) continue;
      items.push(view(todo));
      last = todo;
    }
    // Is there anything left that matches the filter?
    let more = false;
    for (; i < list.length; i++) {
      if (done === undefined || list[i]!.done === done) {
        more = true;
        break;
      }
    }
    sendJson(res, 200, { items, nextCursor: more && last !== undefined ? encodeCursor(last.seq) : null });
  });

  router.add("GET", "/todos/:id", ({ req, res, params }) => {
    const userId = requireUser(req, store);
    const todo = store.getTodo(userId, params.id!);
    if (todo === undefined) throw notFound();
    sendJson(res, 200, view(todo));
  });

  router.add("PATCH", "/todos/:id", async ({ req, res, params }) => {
    const userId = requireUser(req, store);
    const todo = store.getTodo(userId, params.id!);
    if (todo === undefined) throw notFound();
    const body = asObject(await readJson(req));
    const patch: { title?: string; done?: boolean } = {};
    if (body.title !== undefined) patch.title = validTitle(body.title);
    if (body.done !== undefined) {
      if (typeof body.done !== "boolean") throw invalidBody("done must be a boolean");
      patch.done = body.done;
    }
    sendJson(res, 200, view(store.updateTodo(todo, patch)));
  });

  router.add("DELETE", "/todos/:id", ({ req, res, params }) => {
    const userId = requireUser(req, store);
    const todo = store.getTodo(userId, params.id!);
    if (todo === undefined) throw notFound();
    store.deleteTodo(todo);
    sendEmpty(res, 204);
  });
}
