import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface User {
  id: string;
  email: string;
  /** `scrypt$<salt hex>$<hash hex>` */
  passwordHash: string;
}

export interface Todo {
  id: string;
  ownerId: string;
  title: string;
  done: boolean;
  due: string | null;
  createdAt: string;
  /** Creation order; the listing cursor points at it. */
  seq: number;
}

interface Snapshot {
  users: User[];
  todos: Todo[];
  tokens: Record<string, string>;
  seq: number;
}

/**
 * In-memory state with optional JSON persistence. Writes are synchronous and atomic
 * (write a temp file, then rename), so a restart never sees a half-written file.
 */
export class Store {
  private readonly users = new Map<string, User>();
  private readonly usersByEmail = new Map<string, User>();
  private readonly todos = new Map<string, Todo>();
  /** ownerId → todos in creation order. Listing never scans other users' todos. */
  private readonly todosByOwner = new Map<string, Todo[]>();
  private readonly tokens = new Map<string, string>();
  private seq = 0;
  private readonly dataFile: string | undefined;

  constructor(dataFile?: string) {
    this.dataFile = dataFile;
    if (dataFile !== undefined && existsSync(dataFile)) {
      const snap = JSON.parse(readFileSync(dataFile, "utf8")) as Snapshot;
      for (const u of snap.users) this.indexUser(u);
      for (const t of snap.todos) this.indexTodo(t);
      for (const [token, userId] of Object.entries(snap.tokens)) this.tokens.set(token, userId);
      this.seq = snap.seq;
    }
  }

  findUserByEmail(email: string): User | undefined {
    return this.usersByEmail.get(email.toLowerCase());
  }

  addUser(email: string, passwordHash: string): User {
    const user: User = { id: randomUUID(), email, passwordHash };
    this.indexUser(user);
    this.persist();
    return user;
  }

  addToken(token: string, userId: string): void {
    this.tokens.set(token, userId);
    this.persist();
  }

  userIdForToken(token: string): string | undefined {
    return this.tokens.get(token);
  }

  addTodo(ownerId: string, title: string, due: string | null): Todo {
    this.seq += 1;
    const todo: Todo = {
      id: randomUUID(),
      ownerId,
      title,
      done: false,
      due,
      createdAt: new Date().toISOString(),
      seq: this.seq,
    };
    this.indexTodo(todo);
    this.persist();
    return todo;
  }

  /** The todo, only if `ownerId` owns it. */
  getTodo(ownerId: string, id: string): Todo | undefined {
    const todo = this.todos.get(id);
    return todo !== undefined && todo.ownerId === ownerId ? todo : undefined;
  }

  updateTodo(todo: Todo, patch: { title?: string; done?: boolean }): Todo {
    if (patch.title !== undefined) todo.title = patch.title;
    if (patch.done !== undefined) todo.done = patch.done;
    this.persist();
    return todo;
  }

  deleteTodo(todo: Todo): void {
    this.todos.delete(todo.id);
    const list = this.todosByOwner.get(todo.ownerId);
    if (list !== undefined) {
      const i = list.indexOf(todo);
      if (i >= 0) list.splice(i, 1);
    }
    this.persist();
  }

  /** The owner's todos in creation order (oldest first). */
  todosOf(ownerId: string): readonly Todo[] {
    return this.todosByOwner.get(ownerId) ?? [];
  }

  private indexUser(user: User): void {
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email.toLowerCase(), user);
  }

  private indexTodo(todo: Todo): void {
    this.todos.set(todo.id, todo);
    const list = this.todosByOwner.get(todo.ownerId);
    if (list === undefined) this.todosByOwner.set(todo.ownerId, [todo]);
    else list.push(todo);
  }

  private persist(): void {
    if (this.dataFile === undefined) return;
    const snap: Snapshot = {
      users: [...this.users.values()],
      todos: [...this.todos.values()],
      tokens: Object.fromEntries(this.tokens),
      seq: this.seq,
    };
    mkdirSync(dirname(this.dataFile), { recursive: true });
    const tmp = `${this.dataFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, this.dataFile);
  }
}
