import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadConfig, type Env } from "./config.ts";
import { HttpError, sendError } from "./http.ts";
import { authenticate } from "./middleware/auth.ts";
import { listUsers } from "./routes/admin.ts";
import { login } from "./routes/login.ts";
import { logout } from "./routes/logout.ts";
import { me } from "./routes/me.ts";
import { refresh } from "./routes/refresh.ts";
import { SessionStore } from "./sessions.ts";
import { UserStore } from "./users.ts";

export interface AppOptions {
  env?: Env;
}

export function createApp(options: AppOptions = {}): Server {
  const config = loadConfig(options.env ?? process.env);
  const users = new UserStore();
  const sessions = new SessionStore(config);
  const deps = { config, users, sessions };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const key = `${req.method} ${path}`;
    switch (key) {
      case "POST /auth/login":
        return login(req, res, deps);
      case "POST /auth/logout":
        return logout(res, authenticate(req, deps), deps);
      case "POST /auth/refresh":
        return refresh(res, authenticate(req, deps), deps);
      case "GET /me":
        return me(res, authenticate(req, deps), deps);
      case "GET /admin/users":
        return listUsers(res, authenticate(req, deps), deps);
      default:
        throw new HttpError(404, "not_found", `no route for ${key}`);
    }
  }

  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) sendError(res, err);
      else {
        console.error(err);
        sendError(res, new HttpError(500, "internal", "internal error"));
      }
    });
  });
}
