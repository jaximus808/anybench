export type Role = "admin" | "user";

/** Who is calling. Built by `middleware/auth.ts` and passed to every protected route. */
export interface AuthContext {
  userId: string;
  role: Role;
  sessionId: string;
}
