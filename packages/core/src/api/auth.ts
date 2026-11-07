// Auth routes: GitHub OAuth, the session, who am I (plan.md section 9). Ticket 7.1 implements them.
import { z } from "zod";
import { UserIdSchema } from "../ids.js";
import { IsoDateTimeSchema, OkSchema, RedirectSchema } from "./common.js";
import { defineRoute, defineRoutes } from "./route.js";

/** Session cookie name. `Domain=.anybench.jaxonp.com; Secure; HttpOnly; SameSite=Lax`. */
export const SESSION_COOKIE = "anybench_session";

export const UserSchema = z.object({
  id: UserIdSchema,
  github_login: z.string().min(1),
  email: z.email().nullable(),
  avatar_url: z.url().nullable(),
  is_admin: z.boolean(),
  created_at: IsoDateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;

/** Where the caller's credentials came from, so a CLI can show "signed in as … with key …". */
export const WhoAmISchema = z.object({
  user: UserSchema,
  via: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("session") }),
    z.object({
      kind: z.literal("api_key"),
      key_id: z.string(),
      scopes: z.array(z.string()),
      run_ids: z.array(z.string()).nullable(),
    }),
  ]),
});

/** Only relative paths (or the web origin, checked by the server) may follow sign-in. */
const RedirectToSchema = z
  .string()
  .max(2048)
  .refine((s) => s.startsWith("/") && !s.startsWith("//"), {
    message: "redirect_to must be a relative path",
  });

export const authRoutes = defineRoutes({
  githubStart: defineRoute({
    id: "auth.githubStart",
    method: "GET",
    path: "/auth/github",
    auth: ["public"],
    summary: "Start GitHub OAuth: set the HMAC'd state cookie and redirect to GitHub.",
    query: z.object({ redirect_to: RedirectToSchema.optional() }),
    kind: "redirect",
    status: 302,
    response: RedirectSchema,
  }),
  githubCallback: defineRoute({
    id: "auth.githubCallback",
    method: "GET",
    path: "/auth/github/callback",
    auth: ["public"],
    summary: "GitHub OAuth callback: verify state, upsert the user, set the session cookie.",
    query: z.object({ code: z.string().min(1), state: z.string().min(1) }),
    kind: "redirect",
    status: 302,
    response: RedirectSchema,
  }),
  me: defineRoute({
    id: "auth.me",
    method: "GET",
    path: "/auth/me",
    auth: ["session", "apiKey:runs:read"],
    summary: "The signed-in user and how they authenticated.",
    response: WhoAmISchema,
  }),
  logout: defineRoute({
    id: "auth.logout",
    method: "POST",
    path: "/auth/logout",
    auth: ["session"],
    summary: "Revoke the session and clear the cookie.",
    response: OkSchema,
  }),
});
