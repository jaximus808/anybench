/* global process */
import { createServer } from "node:http";
const todos = new Map();
let next = 1;
const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const [, , id] = req.url.split("/");
  if (req.url === "/todos" && req.method === "GET") return send(res, 200, [...todos.values()]);
  if (req.url === "/todos" && req.method === "POST") {
    const t = { id: String(next++), title: body.title, done: false };
    todos.set(t.id, t);
    return send(res, 201, t);
  }
  const t = todos.get(id);
  if (!t) return send(res, 404, { error: "not found" });
  if (req.method === "PATCH") {
    t.done = Boolean(body.done);
    return send(res, 200, t);
  }
  if (req.method === "DELETE") {
    todos.delete(id);
    return send(res, 204, {});
  }
  send(res, 405, { error: "method not allowed" });
}).listen(Number(process.env.PORT ?? 3000));
