import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Role } from "./types.ts";

export interface User {
  id: string;
  username: string;
  role: Role;
  passwordHash: string;
}

function hash(password: string, salt = randomBytes(16)): string {
  return `${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
}

export class UserStore {
  private readonly byName = new Map<string, User>();
  private readonly byId = new Map<string, User>();

  constructor() {
    this.add({ id: "u_alice", username: "alice", role: "admin", passwordHash: hash("wonderland") });
    this.add({ id: "u_bob", username: "bob", role: "user", passwordHash: hash("builder123") });
  }

  private add(user: User): void {
    this.byName.set(user.username, user);
    this.byId.set(user.id, user);
  }

  get(id: string): User | undefined {
    return this.byId.get(id);
  }

  list(): User[] {
    return [...this.byId.values()];
  }

  /** The user when the password matches, else undefined. */
  check(username: string, password: string): User | undefined {
    const user = this.byName.get(username);
    if (user === undefined) return undefined;
    const [saltHex, hashHex] = user.passwordHash.split(":") as [string, string];
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), 32);
    return timingSafeEqual(actual, Buffer.from(hashHex, "hex")) ? user : undefined;
  }
}

export function publicUser(user: User): { id: string; username: string; role: Role } {
  return { id: user.id, username: user.username, role: user.role };
}
