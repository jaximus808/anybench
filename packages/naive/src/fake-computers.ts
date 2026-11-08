// FakeNaiveComputers: the `computers` half of FakeNaive. An in-memory model of a Naïve
// micro-VM that keeps the behaviour we recorded on the live box (docs/findings/naive-hosting.md),
// so code written against it is not surprised in production:
//
// - create answers `creating`; the computer turns `running` after `provisionDelayMs`.
// - `fs/*` is rooted at `/home/naive` (inspect's `home`) and refuses anything outside with 403,
//   but the shell user is `tenki` with HOME=/home/tenki, and `/home/naive` does not exist in the
//   shell until someone links it. fs writes land under the shell home.
// - An fs write can take a moment to show up in the shell (`fsVisibilityDelayMs`; live: ~0.7 s).
// - fs/write does not create parent directories (fs/mkdir does). This is stricter than we know
//   the live API to be, so callers that pass here mkdir first.
// - exec on `creating`/`failed`/destroyed is 409 `computer_unavailable`; on `paused` it resumes.
//   A timeout is exit 124 with "command timed out after <n>ms" on stderr, and it does not kill
//   detached children. A background job whose stdout/stderr are not redirected holds the call
//   open until it exits or the timeout hits, as the live exec does.
// - Creating or resuming needs a balance of one 10-minute block (else 402 insufficient_credits),
//   and create charges that block at the rate card (8 400 µ$ per vCPU + 2 700 µ$ per GiB).
// - A snapshot copies the filesystem only (the live one also copies memory and processes).
//
// Commands run in a small shell: echo, cat, true, false, :, exit, sleep, test/[, mkdir, touch,
// rm, chmod, stat -c, ln -s, readlink -f, dirname, id -un, whoami, pwd, sudo, setsid, nohup and
// sh/bash -c, with ; && || & (background, `$!`), > >> 2> 2>&1 >&2 <, quotes, ~, $VAR, ${VAR} and
// $(…). `sleep` is virtual time waited for real at `timeScale`. Anything else exits 127.

import { posix } from "node:path";
import {
  NaiveConflictError,
  NaiveError,
  NaiveInsufficientCreditsError,
  NaiveNotFoundError,
} from "./errors.js";
import type { MicroUsd } from "./money.js";
import {
  NAIVE_COMPUTER_LIMITS,
  NAIVE_DEFAULT_FS_HOME,
  type NaiveComputer,
  type NaiveComputerCreate,
  type NaiveComputerInspect,
  type NaiveComputersApi,
  type NaiveExecResult,
  type NaiveListQuery,
  type NaivePage,
  type NaiveSnapshot,
} from "./computers.js";

export interface FakeNaiveComputersOptions {
  /** Real milliseconds before a new computer is `running`. Default 0 (running on the first read). */
  provisionDelayMs?: number;
  /** The shell user's home. Default `/home/tenki`, what the live box reported. */
  shellHome?: string;
  /** Where fs/* is rooted, as inspect reports it. Default `/home/naive`. */
  fsHome?: string;
  /** Real milliseconds before an fs write is visible to exec. Default 0. */
  fsVisibilityDelayMs?: number;
  /** Real time per virtual millisecond of `sleep`. Default 1. */
  timeScale?: number;
}

/** What FakeNaive lends its computers: call recording + plan gate + failNext, money, ids, clock. */
export interface FakeComputersHost {
  enter(method: string, args: unknown[]): void;
  balance(): MicroUsd;
  charge(amount: MicroUsd): void;
  id(prefix: string): string;
  now(): Date;
}

export interface FakeComputerCommand {
  computerId: string;
  command: string;
  timeoutMs: number;
  exitCode: number;
  timedOut: boolean;
}

/** The rate card per 10-minute block (docs/findings/naive-hosting.md "Measured cost"). */
export function fakeNaiveBlockPriceMicroUsd(vcpu: number, memoryMb: number): MicroUsd {
  return BigInt(vcpu) * 8_400n + (BigInt(memoryMb) * 2_700n + 1_023n) / 1_024n;
}

interface VmFile {
  data: Uint8Array;
  mode: number;
  /** Real ms timestamp from which the shell sees this version. */
  visibleAt: number;
  /** What the shell sees until then. */
  prev: { data: Uint8Array; mode: number } | null;
}

interface Vm {
  files: Map<string, VmFile>;
  dirs: Set<string>;
  links: Map<string, string>;
  nextPid: number;
}

interface ComputerRecord {
  computer: NaiveComputer;
  vm: Vm;
  readyAt: number;
  failProvision: boolean;
  lastActiveAt: string | null;
}

const SHELL_USER = "tenki";
const enc = new TextEncoder();
const dec = new TextDecoder();

function conflict(message: string, code = "computer_unavailable"): NaiveConflictError {
  return new NaiveConflictError(message, { code, status: 409 });
}
function notFound(message: string): NaiveNotFoundError {
  return new NaiveNotFoundError(message, { code: "not_found", status: 404 });
}
function invalid(message: string, param?: string): NaiveError {
  return new NaiveError(message, { code: "validation_failed", status: 400, param });
}
function forbidden(message: string): NaiveError {
  return new NaiveError(message, { code: "forbidden", status: 403 });
}

const realSleep = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

function cloneVm(vm: Vm): Vm {
  return {
    files: new Map(
      [...vm.files].map(([k, f]) => [
        k,
        { data: f.data.slice(), mode: f.mode, visibleAt: 0, prev: null },
      ]),
    ),
    dirs: new Set(vm.dirs),
    links: new Map(vm.links),
    nextPid: vm.nextPid,
  };
}

export class FakeNaiveComputers implements NaiveComputersApi {
  /** Every exec, in order (what Naïve keeps as command history). */
  readonly commandHistory: FakeComputerCommand[] = [];
  readonly shellHome: string;
  readonly fsHome: string;
  private readonly records = new Map<string, ComputerRecord>();
  private readonly snapshots = new Map<string, { snapshot: NaiveSnapshot; vm: Vm }>();
  private readonly provisionDelayMs: number;
  private readonly fsVisibilityDelayMs: number;
  private readonly timeScale: number;
  private failNextProvisionFlag = false;
  private spent: MicroUsd = 0n;

  constructor(
    private readonly host: FakeComputersHost,
    options: FakeNaiveComputersOptions = {},
  ) {
    this.provisionDelayMs = options.provisionDelayMs ?? 0;
    this.shellHome = posix.normalize(options.shellHome ?? "/home/tenki");
    this.fsHome = posix.normalize(options.fsHome ?? NAIVE_DEFAULT_FS_HOME);
    this.fsVisibilityDelayMs = options.fsVisibilityDelayMs ?? 0;
    this.timeScale = options.timeScale ?? 1;
  }

  // ── test controls ──────────────────────────────────────────────────────────

  /** The next created computer ends `failed` instead of `running`. */
  failNextProvision(): this {
    this.failNextProvisionFlag = true;
    return this;
  }

  /** Adds a computer this test did not create through `create` (an agent's, or someone else's). */
  seed(init: { name: string; agentId?: string | null; status?: "running" | "paused" }): string {
    const rec = this.newRecord({ name: init.name }, null);
    rec.computer.agentId = init.agentId ?? null;
    rec.computer.status = init.status ?? "running";
    rec.readyAt = 0;
    return rec.computer.id;
  }

  /** A file as the shell sees it (absolute shell path, symlinks followed), or undefined. */
  shellFile(computerId: string, path: string): { text: string; mode: number } | undefined {
    const rec = this.rec(computerId);
    const f = visibleFile(rec.vm, resolveShellPath(rec.vm, path, this.shellHome));
    return f ? { text: dec.decode(f.data), mode: f.mode } : undefined;
  }

  /** A symlink's target, or undefined. */
  shellLink(computerId: string, path: string): string | undefined {
    return this.rec(computerId).vm.links.get(posix.normalize(path));
  }

  /** Total charged for computers, integer micro-USD. */
  spentMicroUsd(): MicroUsd {
    return this.spent;
  }

  liveSnapshotIds(): string[] {
    return [...this.snapshots.keys()];
  }

  // ── NaiveComputersApi ──────────────────────────────────────────────────────

  async create(body: NaiveComputerCreate): Promise<NaiveComputer> {
    this.host.enter("computers.create", [body]);
    const vcpu = body.vcpu ?? 2;
    const memoryMb = body.memoryMb ?? 4096;
    const diskGb = body.diskGb ?? 5;
    const L = NAIVE_COMPUTER_LIMITS;
    const intIn = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!intIn(vcpu, L.vcpu.min, L.vcpu.max)) throw invalid("vcpu must be 1-16", "vcpu");
    if (!intIn(memoryMb, L.memoryMb.min, L.memoryMb.max))
      throw invalid("memory_mb must be 128-65536", "memory_mb");
    if (!intIn(diskGb, L.diskGb.min, L.diskGb.max))
      throw invalid("disk_gb must be 1-100", "disk_gb");
    if (body.name !== undefined && (body.name.length < 1 || body.name.length > L.nameMaxChars))
      throw invalid("name must be 1-200 characters", "name");
    let fromVm: Vm | null = null;
    if (body.snapshotId !== undefined) {
      const snap = this.snapshots.get(body.snapshotId);
      if (!snap) throw notFound(`no snapshot ${body.snapshotId}`);
      fromVm = cloneVm(snap.vm);
    }
    const price = fakeNaiveBlockPriceMicroUsd(vcpu, memoryMb);
    if (this.host.balance() < price) {
      throw new NaiveInsufficientCreditsError("balance cannot cover 10 minutes of this computer", {
        code: "insufficient_credits",
        status: 402,
      });
    }
    this.host.charge(price);
    this.spent += price;
    const rec = this.newRecord({ ...body, vcpu, memoryMb, diskGb }, fromVm);
    return { ...rec.computer };
  }

  async get(id: string): Promise<NaiveComputer> {
    this.host.enter("computers.get", [id]);
    return { ...this.refresh(this.rec(id)).computer };
  }

  async list(query: NaiveListQuery = {}): Promise<NaivePage<NaiveComputer>> {
    this.host.enter("computers.list", [query]);
    const all = [...this.records.values()].map((r) => ({ ...this.refresh(r).computer })).reverse();
    const start = query.after ? all.findIndex((c) => c.id === query.after) + 1 : 0;
    const limit = query.limit ?? 20;
    const data = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    return { data, hasMore, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null };
  }

  async inspect(id: string): Promise<NaiveComputerInspect> {
    this.host.enter("computers.inspect", [id]);
    const rec = this.refresh(this.rec(id));
    const { status } = rec.computer;
    const live = status === "running" || status === "paused";
    return {
      id,
      status,
      lastActiveAt: rec.lastActiveAt,
      home: live ? this.fsHome : null,
      probe:
        status === "running"
          ? {
              sampledAt: this.host.now().toISOString(),
              uptimeSeconds: 14,
              processes: 105,
              load1m: 0.02,
              memoryUsedMb: 204,
              memoryTotalMb: Math.max(1, rec.computer.memoryMb - 65),
              diskUsedGb: 2.51,
              diskTotalGb: rec.computer.diskGb - 0.16,
            }
          : null,
    };
  }

  async exec(
    id: string,
    command: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<NaiveExecResult> {
    this.host.enter("computers.exec", [id, command, opts]);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > NAIVE_COMPUTER_LIMITS.maxExecTimeoutMs
    )
      throw invalid("timeout_ms must be 1-600000", "timeout_ms");
    const rec = this.live(id, "exec");
    const result = await new FakeShell(rec.vm, this.shellHome, this.timeScale).run(
      command,
      timeoutMs,
    );
    this.commandHistory.push({
      computerId: id,
      command,
      timeoutMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    return result;
  }

  async pause(id: string): Promise<NaiveComputer> {
    this.host.enter("computers.pause", [id]);
    const rec = this.refresh(this.rec(id));
    if (rec.computer.status !== "running" && rec.computer.status !== "paused")
      throw conflict(`computer ${id} is ${rec.computer.status}`);
    rec.computer.status = "paused";
    return { ...rec.computer };
  }

  async resume(id: string): Promise<NaiveComputer> {
    this.host.enter("computers.resume", [id]);
    return { ...this.live(id, "resume").computer };
  }

  async delete(id: string): Promise<void> {
    this.host.enter("computers.delete", [id]);
    const rec = this.rec(id);
    if (rec.computer.status === "destroyed") throw notFound(`computer ${id} is destroyed`);
    if (rec.computer.agentId !== null)
      throw conflict(`computer ${id} belongs to agent ${rec.computer.agentId}`);
    rec.computer.status = "destroyed";
  }

  async snapshot(id: string): Promise<NaiveSnapshot> {
    this.host.enter("computers.snapshot", [id]);
    const rec = this.live(id, "snapshot");
    const snapshot: NaiveSnapshot = {
      snapshotId: this.host.id("snp"),
      computerId: id,
      createdAt: this.host.now().toISOString(),
    };
    this.snapshots.set(snapshot.snapshotId, { snapshot, vm: cloneVm(rec.vm) });
    return { ...snapshot };
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    this.host.enter("computers.deleteSnapshot", [snapshotId]);
    if (!this.snapshots.has(snapshotId)) throw notFound(`no snapshot ${snapshotId}`);
    const user = [...this.records.values()].find(
      (r) => r.computer.snapshotId === snapshotId && r.computer.status !== "destroyed",
    );
    if (user) throw conflict(`computer ${user.computer.id} was restored from it`, "state_conflict");
    this.snapshots.delete(snapshotId);
    for (const r of this.records.values())
      if (r.computer.snapshotId === snapshotId) r.computer.snapshotId = null;
  }

  async readFile(id: string, path: string): Promise<Uint8Array> {
    this.host.enter("computers.fs.read", [id, path]);
    const rec = this.live(id, "fs/read");
    const p = this.fsPath(rec.vm, path);
    const f = rec.vm.files.get(p);
    if (!f) {
      if (rec.vm.dirs.has(p)) throw invalid(`${path} is a directory`, "path");
      throw notFound(`no such file ${path}`);
    }
    return f.data.slice();
  }

  async writeFile(id: string, path: string, content: Uint8Array): Promise<void> {
    this.host.enter("computers.fs.write", [id, path]);
    const rec = this.live(id, "fs/write");
    const p = this.fsPath(rec.vm, path);
    if (rec.vm.dirs.has(p)) throw invalid(`${path} is a directory`, "path");
    if (!rec.vm.dirs.has(posix.dirname(p))) throw notFound(`parent of ${path} does not exist`);
    const old = rec.vm.files.get(p);
    const now = Date.now();
    const seen = old
      ? old.visibleAt <= now
        ? { data: old.data, mode: old.mode }
        : old.prev
      : null;
    rec.vm.files.set(p, {
      data: content.slice(),
      mode: old?.mode ?? 0o644,
      visibleAt: now + this.fsVisibilityDelayMs,
      prev: seen,
    });
  }

  async mkdir(id: string, path: string): Promise<void> {
    this.host.enter("computers.fs.mkdir", [id, path]);
    const rec = this.live(id, "fs/mkdir");
    const p = this.fsPath(rec.vm, path);
    if (rec.vm.files.has(p)) throw invalid(`${path} is a file`, "path");
    mkdirs(rec.vm, p);
  }

  async remove(id: string, path: string): Promise<void> {
    this.host.enter("computers.fs.remove", [id, path]);
    const rec = this.live(id, "fs/remove");
    const p = this.fsPath(rec.vm, path);
    if (p === this.shellHome || this.shellHome.startsWith(`${p}/`) || p === "/")
      throw invalid(`refusing to remove ${path}`, "path");
    removeTree(rec.vm, p);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private newRecord(body: NaiveComputerCreate, fromVm: Vm | null): ComputerRecord {
    const id = this.host.id("cmp");
    const vm: Vm = fromVm ?? {
      files: new Map([
        [
          "/etc/passwd",
          {
            data: enc.encode(
              `root:x:0:0::/root:/bin/bash\n${SHELL_USER}:x:1000:1000::${this.shellHome}:/bin/bash\n`,
            ),
            mode: 0o644,
            visibleAt: 0,
            prev: null,
          },
        ],
      ]),
      dirs: new Set(["/", "/home", "/tmp", "/etc", "/dev", "/root", this.shellHome]),
      links: new Map(),
      nextPid: 1700,
    };
    const rec: ComputerRecord = {
      computer: {
        id,
        name: body.name ?? "computer",
        vcpu: body.vcpu ?? 2,
        memoryMb: body.memoryMb ?? 4096,
        diskGb: body.diskGb ?? 5,
        status: "creating",
        snapshotId: body.snapshotId ?? null,
        agentId: null,
        createdAt: this.host.now().toISOString(),
      },
      vm,
      readyAt: Date.now() + this.provisionDelayMs,
      failProvision: this.failNextProvisionFlag,
      lastActiveAt: null,
    };
    this.failNextProvisionFlag = false;
    this.records.set(id, rec);
    return rec;
  }

  private rec(id: string): ComputerRecord {
    const rec = this.records.get(id);
    if (!rec) throw notFound(`no computer ${id}`);
    return rec;
  }

  private refresh(rec: ComputerRecord): ComputerRecord {
    if (rec.computer.status === "creating" && Date.now() >= rec.readyAt) {
      rec.computer.status = rec.failProvision ? "failed" : "running";
    }
    return rec;
  }

  /** A computer a call can use: resumes a paused one (charging a block), 409 otherwise. */
  private live(id: string, op: string): ComputerRecord {
    const rec = this.refresh(this.rec(id));
    const { status } = rec.computer;
    if (status === "paused") {
      const price = fakeNaiveBlockPriceMicroUsd(rec.computer.vcpu, rec.computer.memoryMb);
      if (this.host.balance() < price) {
        throw new NaiveInsufficientCreditsError(
          "balance cannot cover 10 minutes of this computer",
          {
            code: "insufficient_credits",
            status: 402,
          },
        );
      }
      rec.computer.status = "running";
    } else if (status !== "running") {
      throw conflict(`${op}: computer ${id} is ${status}`);
    }
    rec.lastActiveAt = this.host.now().toISOString();
    return rec;
  }

  /** fs/* path → the shell path it lands on. 403 outside the fs home, as on Naïve. */
  private fsPath(vm: Vm, path: string): string {
    if (!path.startsWith("/")) throw invalid("path must be absolute", "path");
    const p = posix.normalize(path);
    if (p !== this.fsHome && !p.startsWith(`${this.fsHome}/`))
      throw forbidden(`${path} is outside ${this.fsHome}`);
    const mapped = resolveShellPath(
      vm,
      this.shellHome + p.slice(this.fsHome.length),
      this.shellHome,
    );
    if (mapped !== this.shellHome && !mapped.startsWith(`${this.shellHome}/`))
      throw forbidden(`${path} resolves outside ${this.fsHome}`);
    return mapped;
  }
}

// ---------- filesystem helpers ----------

function resolveShellPath(vm: Vm, path: string, cwd: string): string {
  let p = posix.normalize(posix.isAbsolute(path) ? path : posix.join(cwd, path));
  for (let hops = 0; hops < 16; hops++) {
    let changed = false;
    for (const [link, target] of vm.links) {
      if (p === link || p.startsWith(`${link}/`)) {
        p = posix.normalize(target + p.slice(link.length));
        changed = true;
        break;
      }
    }
    if (!changed) return p;
  }
  return p;
}

function visibleFile(vm: Vm, abs: string): { data: Uint8Array; mode: number } | undefined {
  const f = vm.files.get(abs);
  if (!f) return undefined;
  if (f.visibleAt <= Date.now()) return f;
  return f.prev ?? undefined;
}

function mkdirs(vm: Vm, abs: string): void {
  let cur = abs;
  const todo: string[] = [];
  while (!vm.dirs.has(cur)) {
    todo.push(cur);
    cur = posix.dirname(cur);
  }
  for (const d of todo) vm.dirs.add(d);
}

function removeTree(vm: Vm, abs: string): void {
  for (const k of [...vm.files.keys()])
    if (k === abs || k.startsWith(`${abs}/`)) vm.files.delete(k);
  for (const k of [...vm.dirs]) if (k === abs || k.startsWith(`${abs}/`)) vm.dirs.delete(k);
  for (const k of [...vm.links.keys()])
    if (k === abs || k.startsWith(`${abs}/`)) vm.links.delete(k);
}

// ---------- the fake's shell ----------

type Part =
  { t: "lit"; v: string } | { t: "var"; name: string } | { t: "sub"; src: string } | { t: "tilde" };
type Word = Part[];
type Token = { kind: "word"; word: Word } | { kind: "op"; value: string };
type Redir =
  | { kind: ">" | ">>"; fd: 1 | 2; target: Word }
  | { kind: "<"; target: Word }
  | { kind: "2>&1" }
  | { kind: ">&2" };
interface Simple {
  words: Word[];
  redirs: Redir[];
}
interface Item {
  chain: Array<{ op: "&&" | "||" | null; cmd: Simple }>;
  background: boolean;
}

class ShellSyntaxError extends Error {}
class ExitSignal {
  constructor(readonly code: number) {}
}
class TimeoutSignal {}

const OPS = ["2>&1", "1>&2", ">&2", "2>>", "2>", "&&", "||", ">>", ">", "<", ";", "&", "\n"];

function scanSubst(src: string, i: number): number {
  // src[i] is just after "$(": return the index of the matching ")".
  let depth = 1;
  let quote: string | null = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') j++;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  throw new ShellSyntaxError("unterminated $(");
}

/** `$NAME`, `${NAME}`, `$!`, `$?` or `$(…)` at src[i] === "$"; returns the part and next index. */
function scanDollar(src: string, i: number): [Part, number] {
  const next = src[i + 1];
  if (next === "(") {
    const end = scanSubst(src, i + 2);
    return [{ t: "sub", src: src.slice(i + 2, end) }, end + 1];
  }
  if (next === "{") {
    const end = src.indexOf("}", i + 2);
    if (end < 0) throw new ShellSyntaxError("unterminated ${");
    return [{ t: "var", name: src.slice(i + 2, end) }, end + 1];
  }
  if (next === "!" || next === "?" || next === "$") return [{ t: "var", name: next }, i + 2];
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1));
  if (!m) return [{ t: "lit", v: "$" }, i + 1];
  return [{ t: "var", name: m[0] }, i + 1 + m[0].length];
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    const rest = src.slice(i);
    const op = OPS.find((o) => rest.startsWith(o));
    if (op) {
      tokens.push({ kind: "op", value: op === "1>&2" ? ">&2" : op });
      i += op.length;
      continue;
    }
    if (ch === "|" || ch === "(" || ch === ")" || ch === "`") {
      throw new ShellSyntaxError(`the fake shell does not support '${ch}'`);
    }
    const word: Word = [];
    let lit = "";
    const flush = () => {
      if (lit) word.push({ t: "lit", v: lit });
      lit = "";
    };
    let first = true;
    while (i < src.length && !" \t\n;&|<>()`".includes(src[i]!)) {
      const c = src[i]!;
      if (c === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new ShellSyntaxError("unterminated single quote");
        lit += src.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        i++;
        while (i < src.length && src[i] !== '"') {
          const d = src[i]!;
          if (d === "\\" && i + 1 < src.length && '"\\$`'.includes(src[i + 1]!)) {
            lit += src[i + 1];
            i += 2;
          } else if (d === "$") {
            flush();
            const [part, j] = scanDollar(src, i);
            word.push(part);
            i = j;
          } else {
            lit += d;
            i++;
          }
        }
        if (i >= src.length) throw new ShellSyntaxError("unterminated double quote");
        i++;
      } else if (c === "\\" && i + 1 < src.length) {
        lit += src[i + 1];
        i += 2;
      } else if (c === "$") {
        flush();
        const [part, j] = scanDollar(src, i);
        word.push(part);
        i = j;
      } else if (c === "~" && first && (i + 1 >= src.length || "/ \t\n;&".includes(src[i + 1]!))) {
        word.push({ t: "tilde" });
        i++;
      } else {
        lit += c;
        i++;
      }
      first = false;
    }
    flush();
    tokens.push({ kind: "word", word });
  }
  return tokens;
}

function parse(src: string): Item[] {
  const items: Item[] = [];
  let chain: Item["chain"] = [];
  let cmd: Simple = { words: [], redirs: [] };
  let pendingOp: "&&" | "||" | null = null;
  const tokens = tokenize(src);
  const endCmd = () => {
    if (cmd.words.length === 0 && cmd.redirs.length === 0) {
      if (pendingOp !== null) throw new ShellSyntaxError(`syntax error near '${pendingOp}'`);
      return false;
    }
    chain.push({ op: pendingOp, cmd });
    cmd = { words: [], redirs: [] };
    pendingOp = null;
    return true;
  };
  const endItem = (background: boolean) => {
    endCmd();
    if (chain.length > 0) items.push({ chain, background });
    else if (background) throw new ShellSyntaxError("syntax error near '&'");
    chain = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "word") {
      cmd.words.push(t.word);
      continue;
    }
    switch (t.value) {
      case ";":
      case "\n":
        endItem(false);
        break;
      case "&":
        endItem(true);
        break;
      case "&&":
      case "||":
        if (!endCmd()) throw new ShellSyntaxError(`syntax error near '${t.value}'`);
        pendingOp = t.value;
        break;
      case ">":
      case ">>":
      case "2>":
      case "2>>":
      case "<": {
        const target = tokens[++i];
        if (!target || target.kind !== "word")
          throw new ShellSyntaxError(`syntax error near '${t.value}'`);
        if (t.value === "<") cmd.redirs.push({ kind: "<", target: target.word });
        else
          cmd.redirs.push({
            kind: t.value.endsWith(">>") ? ">>" : ">",
            fd: t.value.startsWith("2") ? 2 : 1,
            target: target.word,
          });
        break;
      }
      case "2>&1":
      case ">&2":
        cmd.redirs.push(t.value === "2>&1" ? { kind: "2>&1" } : { kind: ">&2" });
        break;
    }
  }
  endItem(false);
  return items;
}

interface Sink {
  write(s: string): void;
  /** Where it goes: the exec's own pipe, a file, or nowhere. */
  readonly kind: "pipe" | "file" | "null";
}

interface Ctx {
  io: { out: Sink; err: Sink };
  privileged: boolean;
  /** Virtual ms used and allowed (Infinity for a detached job). */
  clock: { used: number; deadline: number };
  /** Background jobs that still hold the exec's pipe. */
  holders: Promise<void>[];
  vars: { lastBg: string; lastExit: number };
}

class FakeShell {
  constructor(
    private readonly vm: Vm,
    private readonly home: string,
    private readonly timeScale: number,
  ) {}

  async run(command: string, timeoutMs: number): Promise<NaiveExecResult> {
    let stdout = "";
    let stderr = "";
    const out: Sink = { kind: "pipe", write: (s) => void (stdout += s) };
    const err: Sink = { kind: "pipe", write: (s) => void (stderr += s) };
    const ctx: Ctx = {
      io: { out, err },
      privileged: false,
      clock: { used: 0, deadline: timeoutMs },
      holders: [],
      vars: { lastBg: "", lastExit: 0 },
    };
    const startedReal = Date.now();
    let exitCode = 0;
    let timedOut = false;
    try {
      exitCode = await this.runScript(command, ctx);
    } catch (e) {
      if (e instanceof TimeoutSignal) timedOut = true;
      else throw e;
    }
    if (!timedOut && ctx.holders.length > 0) {
      // A background job that kept stdout/stderr holds the call open (live behaviour).
      const leftReal = Math.max(
        0,
        (timeoutMs - ctx.clock.used) * this.timeScale - (Date.now() - startedReal),
      );
      let timer: NodeJS.Timeout | undefined;
      const expired = await Promise.race([
        Promise.all(ctx.holders).then(() => false),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(true), leftReal))),
      ]);
      clearTimeout(timer);
      if (expired) timedOut = true;
    }
    if (timedOut) {
      stderr += `command timed out after ${timeoutMs}ms`;
      exitCode = 124;
    }
    const cap = NAIVE_COMPUTER_LIMITS.maxOutputChars;
    const truncated = stdout.length > cap || stderr.length > cap;
    return {
      stdout: stdout.slice(0, cap),
      stderr: stderr.slice(0, cap),
      exitCode,
      durationMs: Math.round(timedOut ? timeoutMs : ctx.clock.used),
      timedOut,
      truncated,
    };
  }

  private async runScript(src: string, ctx: Ctx): Promise<number> {
    let items: Item[];
    try {
      items = parse(src);
    } catch (e) {
      if (!(e instanceof ShellSyntaxError)) throw e;
      ctx.io.err.write(`sh: ${e.message}\n`);
      return 2;
    }
    let status = 0;
    try {
      for (const item of items) {
        if (item.background) {
          const pid = this.vm.nextPid++;
          ctx.vars.lastBg = String(pid);
          const job: Ctx = {
            ...ctx,
            clock: { used: 0, deadline: Number.POSITIVE_INFINITY },
            holders: [],
            vars: { ...ctx.vars },
          };
          const holds = item.chain.some((c) => this.holdsPipe(c.cmd, ctx));
          const done = this.runChain(item, job).then(
            () => undefined,
            () => undefined,
          );
          if (holds) ctx.holders.push(done);
          status = 0;
        } else {
          status = await this.runChain(item, ctx);
        }
        ctx.vars.lastExit = status;
      }
    } catch (e) {
      if (e instanceof ExitSignal) return e.code;
      throw e;
    }
    return status;
  }

  /** Would this background command still write to the exec's own pipe? */
  private holdsPipe(cmd: Simple, ctx: Ctx): boolean {
    let out: Sink["kind"] = ctx.io.out.kind;
    let err: Sink["kind"] = ctx.io.err.kind;
    for (const r of cmd.redirs) {
      if (r.kind === ">" || r.kind === ">>") {
        if (r.fd === 1) out = "file";
        else err = "file";
      } else if (r.kind === "2>&1") err = out;
      else if (r.kind === ">&2") out = err;
    }
    return out === "pipe" || err === "pipe";
  }

  private async runChain(item: Item, ctx: Ctx): Promise<number> {
    let status = 0;
    for (const { op, cmd } of item.chain) {
      if (op === "&&" && status !== 0) continue;
      if (op === "||" && status === 0) continue;
      status = await this.runSimple(cmd, ctx);
      ctx.vars.lastExit = status;
    }
    return status;
  }

  private async expand(word: Word, ctx: Ctx): Promise<string> {
    let s = "";
    for (const p of word) {
      if (p.t === "lit") s += p.v;
      else if (p.t === "tilde") s += this.home;
      else if (p.t === "var") {
        if (p.name === "HOME") s += this.home;
        else if (p.name === "USER") s += SHELL_USER;
        else if (p.name === "!") s += ctx.vars.lastBg;
        else if (p.name === "?") s += String(ctx.vars.lastExit);
        else if (p.name === "$") s += "1563";
      } else {
        let captured = "";
        const sub: Ctx = {
          ...ctx,
          io: { out: { kind: "pipe", write: (x) => void (captured += x) }, err: ctx.io.err },
          vars: { ...ctx.vars },
        };
        await this.runScript(p.src, sub);
        s += captured.replace(/\n+$/, "");
      }
    }
    return s;
  }

  private path(p: string): string {
    return resolveShellPath(this.vm, p, this.home);
  }

  private writable(abs: string, ctx: Ctx): boolean {
    return (
      ctx.privileged ||
      abs === this.home ||
      abs.startsWith(`${this.home}/`) ||
      abs.startsWith("/tmp/") ||
      abs === "/dev/null"
    );
  }

  private openFile(target: string, append: boolean, ctx: Ctx): Sink | string {
    if (target === "/dev/null") return { kind: "null", write: () => undefined };
    const abs = this.path(target);
    if (this.vm.dirs.has(abs)) return `sh: ${target}: Is a directory\n`;
    if (!this.vm.dirs.has(posix.dirname(abs))) return `sh: ${target}: No such file or directory\n`;
    if (!this.writable(abs, ctx)) return `sh: ${target}: Permission denied\n`;
    const old = visibleFile(this.vm, abs);
    const file: VmFile = {
      data: append && old ? old.data : new Uint8Array(),
      mode: old?.mode ?? 0o644,
      visibleAt: 0,
      prev: null,
    };
    this.vm.files.set(abs, file);
    return {
      kind: "file",
      write: (s) => {
        const add = enc.encode(s);
        const next = new Uint8Array(file.data.length + add.length);
        next.set(file.data);
        next.set(add, file.data.length);
        file.data = next;
      },
    };
  }

  private async runSimple(cmd: Simple, outer: Ctx): Promise<number> {
    let { out, err } = outer.io;
    for (const r of cmd.redirs) {
      if (r.kind === "2>&1") err = out;
      else if (r.kind === ">&2") out = err;
      else if (r.kind === "<") {
        const t = await this.expand(r.target, outer);
        if (t !== "/dev/null" && !visibleFile(this.vm, this.path(t))) {
          err.write(`sh: ${t}: No such file or directory\n`);
          return 1;
        }
      } else {
        const t = await this.expand(r.target, outer);
        const sink = this.openFile(t, r.kind === ">>", outer);
        if (typeof sink === "string") {
          err.write(sink);
          return 1;
        }
        if (r.fd === 1) out = sink;
        else err = sink;
      }
    }
    const argv: string[] = [];
    for (const w of cmd.words) argv.push(await this.expand(w, outer));
    return this.runArgv(argv, { ...outer, io: { out, err } });
  }

  private async sleepVirtual(ms: number, ctx: Ctx): Promise<void> {
    const left = ctx.clock.deadline - ctx.clock.used;
    if (ms > left) {
      await realSleep(left * this.timeScale);
      ctx.clock.used = ctx.clock.deadline;
      throw new TimeoutSignal();
    }
    await realSleep(ms * this.timeScale);
    ctx.clock.used += ms;
  }

  private async runArgv(argv: string[], ctx: Ctx): Promise<number> {
    const [cmd, ...args] = argv;
    const { out, err } = ctx.io;
    if (cmd === undefined) return 0;
    switch (cmd) {
      case "echo": {
        const n = args[0] === "-n";
        out.write((n ? args.slice(1) : args).join(" ") + (n ? "" : "\n"));
        return 0;
      }
      case "cat": {
        for (const p of args) {
          const f = visibleFile(this.vm, this.path(p));
          if (!f) {
            err.write(`cat: ${p}: No such file or directory\n`);
            return 1;
          }
          out.write(dec.decode(f.data));
        }
        return 0;
      }
      case "true":
      case ":":
        return 0;
      case "false":
        return 1;
      case "exit": {
        const n = args[0] === undefined ? ctx.vars.lastExit : Number.parseInt(args[0], 10);
        throw new ExitSignal(Number.isNaN(n) ? 2 : n & 0xff);
      }
      case "sleep": {
        const secs = Number.parseFloat(args[0] ?? "");
        if (!Number.isFinite(secs) || secs < 0) {
          err.write(`sleep: invalid time interval '${args[0] ?? ""}'\n`);
          return 1;
        }
        await this.sleepVirtual(secs * 1000, ctx);
        return 0;
      }
      case "test":
      case "[": {
        let a = args;
        if (cmd === "[") {
          if (a.at(-1) !== "]") {
            err.write("[: missing ']'\n");
            return 2;
          }
          a = a.slice(0, -1);
        }
        const r = this.test(a);
        if (r === null) {
          err.write(`${cmd}: unsupported expression: ${a.join(" ")}\n`);
          return 2;
        }
        return r ? 0 : 1;
      }
      case "mkdir": {
        const parents = args.includes("-p");
        for (const p of args.filter((x) => !x.startsWith("-"))) {
          const abs = this.path(p);
          if (this.vm.dirs.has(abs)) {
            if (!parents) {
              err.write(`mkdir: cannot create directory '${p}': File exists\n`);
              return 1;
            }
            continue;
          }
          if (!this.writable(abs, ctx)) {
            err.write(`mkdir: cannot create directory '${p}': Permission denied\n`);
            return 1;
          }
          if (!parents && !this.vm.dirs.has(posix.dirname(abs))) {
            err.write(`mkdir: cannot create directory '${p}': No such file or directory\n`);
            return 1;
          }
          mkdirs(this.vm, abs);
        }
        return 0;
      }
      case "touch": {
        for (const p of args) {
          const s = this.openFile(p, true, ctx);
          if (typeof s === "string") {
            err.write(s.replace(/^sh/, "touch"));
            return 1;
          }
        }
        return 0;
      }
      case "rm": {
        for (const p of args.filter((x) => !x.startsWith("-"))) {
          const abs = this.path(p);
          if (!this.writable(abs, ctx)) {
            err.write(`rm: cannot remove '${p}': Permission denied\n`);
            return 1;
          }
          removeTree(this.vm, abs);
        }
        return 0;
      }
      case "chmod": {
        const [modeArg, ...paths] = args;
        if (!modeArg || !/^[0-7]{3,4}$/.test(modeArg) || paths.length === 0) {
          err.write("chmod: the fake supports octal modes only\n");
          return 1;
        }
        for (const p of paths) {
          const abs = this.path(p);
          const f = this.vm.files.get(abs);
          if (!f || !visibleFile(this.vm, abs)) {
            if (this.vm.dirs.has(abs)) continue;
            err.write(`chmod: cannot access '${p}': No such file or directory\n`);
            return 1;
          }
          f.mode = Number.parseInt(modeArg, 8);
          if (f.prev) f.prev.mode = f.mode;
        }
        return 0;
      }
      case "stat": {
        const fi = args.indexOf("-c");
        const fmt = fi >= 0 ? args[fi + 1] : undefined;
        const paths = args.filter((_, i) => i !== fi && i !== fi + 1);
        if (fmt === undefined) {
          err.write("stat: the fake supports -c FORMAT only\n");
          return 1;
        }
        for (const p of paths) {
          const abs = this.path(p);
          const f = visibleFile(this.vm, abs);
          const isDir = this.vm.dirs.has(abs);
          if (!f && !isDir) {
            err.write(`stat: cannot statx '${p}': No such file or directory\n`);
            return 1;
          }
          const mode = f ? f.mode : 0o755;
          out.write(
            fmt
              .replaceAll("%s", String(f ? f.data.length : 4096))
              .replaceAll("%a", mode.toString(8))
              .replaceAll("%U", SHELL_USER)
              .replaceAll("%n", p) + "\n",
          );
        }
        return 0;
      }
      case "ln": {
        const flags = args.filter((x) => x.startsWith("-")).join("");
        const [target, link] = args.filter((x) => !x.startsWith("-"));
        if (!flags.includes("s") || target === undefined || link === undefined) {
          err.write("ln: the fake supports ln -s TARGET LINK only\n");
          return 1;
        }
        const abs = posix.normalize(posix.isAbsolute(link) ? link : posix.join(this.home, link));
        if (!this.writable(abs, ctx)) {
          err.write(`ln: failed to create symbolic link '${link}': Permission denied\n`);
          return 1;
        }
        const exists = this.vm.links.has(abs) || this.vm.dirs.has(abs) || this.vm.files.has(abs);
        if (exists && !flags.includes("f")) {
          err.write(`ln: failed to create symbolic link '${link}': File exists\n`);
          return 1;
        }
        this.vm.links.set(
          abs,
          posix.normalize(
            posix.isAbsolute(target) ? target : posix.join(posix.dirname(abs), target),
          ),
        );
        return 0;
      }
      case "readlink": {
        const p = args.filter((x) => !x.startsWith("-"))[0];
        if (p === undefined || !args.includes("-f")) {
          err.write("readlink: the fake supports readlink -f PATH only\n");
          return 1;
        }
        out.write(`${this.path(p)}\n`);
        return 0;
      }
      case "dirname": {
        if (args[0] === undefined) return 1;
        out.write(`${posix.dirname(args[0])}\n`);
        return 0;
      }
      case "id":
      case "whoami":
        out.write(`${SHELL_USER}\n`);
        return 0;
      case "pwd":
        out.write(`${this.home}\n`);
        return 0;
      case "sudo": {
        const rest = args[0] === "-n" ? args.slice(1) : args;
        return this.runArgv(rest, { ...ctx, privileged: true });
      }
      case "setsid":
      case "nohup":
        return this.runArgv(args, ctx);
      case "sh":
      case "bash": {
        if (args[0] !== "-c" || args[1] === undefined) {
          err.write(`${cmd}: the fake supports ${cmd} -c SCRIPT only\n`);
          return 2;
        }
        return this.runScript(args[1], { ...ctx, vars: { ...ctx.vars } });
      }
      default:
        err.write(`sh: ${cmd}: command not found\n`);
        return 127;
    }
  }

  private test(a: string[]): boolean | null {
    if (a[0] === "!") {
      const r = this.test(a.slice(1));
      return r === null ? null : !r;
    }
    if (a.length === 0) return false;
    if (a.length === 1) return a[0] !== "";
    if (a.length === 2) {
      const [flag, x] = a as [string, string];
      const abs = this.path(x);
      switch (flag) {
        case "-n":
          return x !== "";
        case "-z":
          return x === "";
        case "-f":
          return visibleFile(this.vm, abs) !== undefined;
        case "-d":
          return this.vm.dirs.has(abs);
        case "-e":
          return visibleFile(this.vm, abs) !== undefined || this.vm.dirs.has(abs);
        case "-s":
          return (visibleFile(this.vm, abs)?.data.length ?? 0) > 0;
        case "-L":
          return this.vm.links.has(posix.normalize(x));
        case "-w":
          return this.vm.dirs.has(abs) || visibleFile(this.vm, abs) !== undefined;
      }
      return null;
    }
    if (a.length === 3) {
      if (a[1] === "=" || a[1] === "==") return a[0] === a[2];
      if (a[1] === "!=") return a[0] !== a[2];
    }
    return null;
  }
}
