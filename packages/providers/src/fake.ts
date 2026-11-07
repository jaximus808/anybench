// FakeProvider: an in-memory ComputeProvider for unit tests. No network, no money.
//
// - Lifecycle mirrors Naïve: create returns `creating`, becomes `running` after
//   `provisionDelayMs`; exec/putFile/getFile/snapshot on a paused computer resume it.
// - Each computer has an in-memory filesystem (whole machine; putFile/getFile are
//   still confined to `home`, as on Naïve).
// - exec is scripted: `onExec(matcher, handler)` handlers win; otherwise a tiny
//   built-in shell runs a small vocabulary (echo, cat, sleep, exit, true, false,
//   mkdir, touch, rm, test/[ ), with `&&`, `||`, `;`, `>`, `>>`, `>&2`, `2>&1`,
//   quoting, `~` and `$HOME`. Unknown commands exit 127.
// - `sleep` and handler `durationMs` are virtual time, waited for real at `timeScale`
//   (0.01 makes a 5 s sleep take 50 ms), so timeouts behave without slow tests.
// - Faults: failNext(op, error), failNextProvision(), maxComputers (capacity).
import { posix } from "node:path";
import {
  ProviderCapacityError,
  ProviderError,
  ProviderNotFoundError,
  ProviderUnavailableError,
  ProviderValidationError,
} from "./errors.js";
import {
  capOutput,
  defaultDetachedLogPath,
  effectiveExecTimeout,
  matchesTags,
  pollUntilReady,
  resolveHomePath,
} from "./helpers.js";
import {
  ComputerSpecSchema,
  ExecDetachedOptionsSchema,
  ExecOptionsSchema,
  ListOptionsSchema,
  ProviderCapabilitiesSchema,
  PutFileOptionsSchema,
  type ComputeProvider,
  type ComputerInfo,
  type ComputerSpecInput,
  type ComputerStatus,
  type DetachedProcess,
  type ExecDetachedOptions,
  type ExecOptions,
  type ExecResult,
  type ListOptions,
  type ProviderCapabilities,
  type PutFileOptions,
  type SnapshotInfo,
  type WaitReadyOptions,
} from "./types.js";

export type FakeOp =
  | "create"
  | "waitReady"
  | "inspect"
  | "list"
  | "exec"
  | "execDetached"
  | "putFile"
  | "getFile"
  | "snapshot"
  | "fork"
  | "deleteSnapshot"
  | "pause"
  | "resume"
  | "destroy";

export interface FakeProviderOptions {
  name?: string;
  home?: string;
  capabilities?: Partial<ProviderCapabilities>;
  /** Virtual ms from create until `running`. Default 0. */
  provisionDelayMs?: number;
  /** Real ms waited per virtual ms of sleep. Default 1. */
  timeScale?: number;
  /** Live computers allowed at once; create beyond it throws ProviderCapacityError. */
  maxComputers?: number;
  now?: () => number;
}

export interface FakeExecContext {
  command: string;
  match: RegExpExecArray | null;
  computerId: string;
  home: string;
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string, opts?: { append?: boolean }): void;
}

export interface FakeExecReply {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Virtual run time; over the exec timeout means timedOut. */
  durationMs?: number;
}

export type FakeExecHandler = (
  ctx: FakeExecContext,
) => FakeExecReply | string | Promise<FakeExecReply | string>;
export type FakeExecMatcher = string | RegExp | ((command: string) => boolean);

export interface FakeCommandRecord {
  computerId: string;
  command: string;
  kind: "exec" | "detached";
  at: number;
}

export interface FakeDetachedRecord extends DetachedProcess {
  computerId: string;
  command: string;
  state: "running" | "exited";
  exitCode: number | null;
}

interface FakeFile {
  data: Uint8Array;
  mode: number;
}

interface FakeComputer {
  id: string;
  name: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  tags: string[];
  snapshotId: string | null;
  createdAt: string;
  readyAt: number;
  failProvision: boolean;
  paused: boolean;
  destroyed: boolean;
  files: Map<string, FakeFile>;
}

interface FakeSnapshot {
  id: string;
  computerId: string;
  createdAt: string;
  files: Map<string, FakeFile>;
}

const FAKE_DEFAULT_CAPABILITIES: ProviderCapabilities = {
  snapshot: true,
  fork: true,
  pause: true,
  maxExecTimeoutMs: 600_000,
  maxOutputChars: 262_144,
  billing: { kind: "block", blockSeconds: 600 },
};

const enc = new TextEncoder();
const dec = new TextDecoder();

const realSleep = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

function copyFiles(files: Map<string, FakeFile>): Map<string, FakeFile> {
  return new Map([...files].map(([k, v]) => [k, { data: v.data.slice(), mode: v.mode }]));
}

export class FakeProvider implements ComputeProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  readonly home: string;

  private readonly provisionDelayMs: number;
  private readonly timeScale: number;
  private readonly maxComputers: number;
  private readonly now: () => number;
  private readonly computers = new Map<string, FakeComputer>();
  private readonly snapshots = new Map<string, FakeSnapshot>();
  private readonly handlers: { matcher: FakeExecMatcher; handler: FakeExecHandler }[] = [];
  private readonly faults = new Map<FakeOp, ProviderError[]>();
  private readonly commandLog: FakeCommandRecord[] = [];
  private readonly detachedLog: FakeDetachedRecord[] = [];
  private readonly running = new Set<Promise<void>>();
  private failProvisionCount = 0;
  private seq = 0;
  private pidSeq = 1000;

  constructor(opts: FakeProviderOptions = {}) {
    this.name = opts.name ?? "fake";
    this.home = opts.home ?? "/home/naive";
    this.capabilities = ProviderCapabilitiesSchema.parse({
      ...FAKE_DEFAULT_CAPABILITIES,
      ...opts.capabilities,
    });
    this.provisionDelayMs = opts.provisionDelayMs ?? 0;
    this.timeScale = opts.timeScale ?? 1;
    this.maxComputers = opts.maxComputers ?? Number.POSITIVE_INFINITY;
    this.now = opts.now ?? Date.now;
  }

  // ---------- test controls ----------

  /** Script exec: the first matching handler (most recent first) answers the command. */
  onExec(matcher: FakeExecMatcher, handler: FakeExecHandler): this {
    this.handlers.unshift({ matcher, handler });
    return this;
  }

  /** The next call of `op` throws `error` (queued, one per call). */
  failNext(op: FakeOp, error: ProviderError): this {
    const q = this.faults.get(op) ?? [];
    q.push(error);
    this.faults.set(op, q);
    return this;
  }

  /** The next created computer ends in `failed` instead of `running`. */
  failNextProvision(count = 1): this {
    this.failProvisionCount += count;
    return this;
  }

  /** Every exec / execDetached command, oldest first (assert no secret ever hit a command line). */
  commands(computerId?: string): FakeCommandRecord[] {
    return this.commandLog.filter((c) => computerId === undefined || c.computerId === computerId);
  }

  detached(computerId?: string): FakeDetachedRecord[] {
    return this.detachedLog.filter((d) => computerId === undefined || d.computerId === computerId);
  }

  /** File modes and contents of a computer, for assertions (e.g. secrets written 0600). */
  fileStat(computerId: string, path: string): { mode: number; size: number } | undefined {
    const f = this.computers.get(computerId)?.files.get(path);
    return f && { mode: f.mode, size: f.data.byteLength };
  }

  /** Wait for every detached command still running. */
  async settle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  // ---------- ComputeProvider ----------

  async create(specInput: ComputerSpecInput): Promise<ComputerInfo> {
    this.fault("create");
    const spec = this.parseSpec(specInput);
    const live = [...this.computers.values()].filter((c) => !c.destroyed).length;
    if (live >= this.maxComputers) {
      throw new ProviderCapacityError(`fake capacity reached (${this.maxComputers} computers)`, {
        provider: this.name,
      });
    }
    let files = new Map<string, FakeFile>();
    if (spec.snapshotId !== undefined) {
      const snap = this.snapshots.get(spec.snapshotId);
      if (!snap)
        throw new ProviderNotFoundError(`snapshot ${spec.snapshotId} not found`, {
          provider: this.name,
          resource: spec.snapshotId,
        });
      files = copyFiles(snap.files);
    }
    const id = `fake_${(++this.seq).toString().padStart(6, "0")}`;
    const failProvision = this.failProvisionCount > 0;
    if (failProvision) this.failProvisionCount--;
    const c: FakeComputer = {
      id,
      name: spec.name ?? "computer",
      vcpu: spec.vcpu,
      memoryMb: spec.memoryMb,
      diskGb: spec.diskGb,
      tags: [...spec.tags],
      snapshotId: spec.snapshotId ?? null,
      createdAt: new Date(this.now()).toISOString(),
      readyAt: this.now() + this.provisionDelayMs,
      failProvision,
      paused: false,
      destroyed: false,
      files,
    };
    this.computers.set(id, c);
    return this.info(c);
  }

  async waitReady(id: string, opts?: WaitReadyOptions): Promise<ComputerInfo> {
    this.fault("waitReady");
    return pollUntilReady(
      () => this.inspect(id),
      { intervalMs: 5, ...opts },
      { provider: this.name, id },
    );
  }

  async inspect(id: string): Promise<ComputerInfo> {
    this.fault("inspect");
    return this.info(this.get(id));
  }

  async list(opts?: ListOptions): Promise<ComputerInfo[]> {
    this.fault("list");
    const o = ListOptionsSchema.parse(opts ?? {});
    return [...this.computers.values()]
      .filter((c) => (o.includeDestroyed || !c.destroyed) && matchesTags(c.tags, o))
      .map((c) => this.info(c));
  }

  async exec(id: string, command: string, opts?: ExecOptions): Promise<ExecResult> {
    this.fault("exec");
    const o = ExecOptionsSchema.parse(opts ?? {});
    const timeoutMs = effectiveExecTimeout(o, this.capabilities, this.name);
    const c = this.live(id);
    this.commandLog.push({ computerId: id, command, kind: "exec", at: this.now() });
    const started = Date.now();
    const r = await this.runScript(c, command, timeoutMs);
    const out = capOutput(r.stdout, this.capabilities.maxOutputChars);
    const err = capOutput(r.stderr, this.capabilities.maxOutputChars);
    return {
      stdout: out.text,
      stderr: err.text,
      exitCode: r.timedOut ? 124 : r.exitCode,
      durationMs: Math.max(Math.round(r.virtualMs), Date.now() - started),
      timedOut: r.timedOut,
      truncated: out.truncated || err.truncated,
    };
  }

  async execDetached(
    id: string,
    command: string,
    opts?: ExecDetachedOptions,
  ): Promise<DetachedProcess> {
    this.fault("execDetached");
    const o = ExecDetachedOptionsSchema.parse(opts ?? {});
    const c = this.live(id);
    const pid = ++this.pidSeq;
    const logPath = this.absPath(o.logPath ?? defaultDetachedLogPath(this.home, pid));
    this.commandLog.push({ computerId: id, command, kind: "detached", at: this.now() });
    const rec: FakeDetachedRecord = {
      pid,
      logPath,
      computerId: id,
      command,
      state: "running",
      exitCode: null,
    };
    this.detachedLog.push(rec);
    const job = (async () => {
      await Promise.resolve(); // start after execDetached returns, like a real fork
      const r = await this.runScript(c, command, Number.POSITIVE_INFINITY);
      this.writeFsText(c, logPath, r.stdout + r.stderr, true);
      rec.state = "exited";
      rec.exitCode = r.exitCode;
    })();
    this.running.add(job);
    void job.finally(() => this.running.delete(job));
    return { pid, logPath };
  }

  async putFile(
    id: string,
    path: string,
    content: string | Uint8Array,
    opts?: PutFileOptions,
  ): Promise<void> {
    this.fault("putFile");
    const o = PutFileOptionsSchema.parse(opts ?? {});
    const abs = resolveHomePath(this.home, path, this.name);
    const c = this.live(id);
    const data = typeof content === "string" ? enc.encode(content) : content.slice();
    c.files.set(abs, { data, mode: o.mode ?? 0o644 });
  }

  async getFile(id: string, path: string): Promise<Uint8Array> {
    this.fault("getFile");
    const abs = resolveHomePath(this.home, path, this.name);
    const c = this.live(id);
    const f = c.files.get(abs);
    if (!f)
      throw new ProviderNotFoundError(`file ${abs} not found on ${id}`, {
        provider: this.name,
        resource: abs,
      });
    return f.data.slice();
  }

  async snapshot(id: string): Promise<SnapshotInfo> {
    this.fault("snapshot");
    this.requireCapability("snapshot");
    const c = this.live(id);
    const snapId = `fakesnp_${(++this.seq).toString().padStart(6, "0")}`;
    const createdAt = new Date(this.now()).toISOString();
    this.snapshots.set(snapId, {
      id: snapId,
      computerId: c.id,
      createdAt,
      files: copyFiles(c.files),
    });
    return { snapshotId: snapId, computerId: c.id, createdAt };
  }

  async fork(
    snapshotId: string,
    spec: Omit<ComputerSpecInput, "snapshotId"> = {},
  ): Promise<ComputerInfo> {
    this.fault("fork");
    this.requireCapability("fork");
    return this.create({ ...spec, snapshotId });
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    this.fault("deleteSnapshot");
    if (!this.snapshots.has(snapshotId)) {
      throw new ProviderNotFoundError(`snapshot ${snapshotId} not found`, {
        provider: this.name,
        resource: snapshotId,
      });
    }
    const inUse = [...this.computers.values()].some(
      (c) => !c.destroyed && c.snapshotId === snapshotId,
    );
    if (inUse) {
      throw new ProviderUnavailableError(
        `snapshot ${snapshotId} backs a live computer; destroy it first`,
        {
          provider: this.name,
          resource: snapshotId,
        },
      );
    }
    this.snapshots.delete(snapshotId);
  }

  async pause(id: string): Promise<ComputerInfo> {
    this.fault("pause");
    this.requireCapability("pause");
    const c = this.live(id);
    c.paused = true;
    return this.info(c);
  }

  async resume(id: string): Promise<ComputerInfo> {
    this.fault("resume");
    this.requireCapability("pause");
    const c = this.live(id);
    c.paused = false;
    return this.info(c);
  }

  async destroy(id: string): Promise<void> {
    this.fault("destroy");
    const c = this.computers.get(id);
    if (!c || c.destroyed) return;
    c.destroyed = true;
    c.files = new Map();
  }

  // ---------- internals ----------

  private fault(op: FakeOp): void {
    const err = this.faults.get(op)?.shift();
    if (err) throw err;
  }

  private parseSpec(input: ComputerSpecInput) {
    const r = ComputerSpecSchema.safeParse(input);
    if (!r.success) {
      throw new ProviderValidationError(`invalid computer spec: ${r.error.message}`, {
        provider: this.name,
        cause: r.error,
      });
    }
    return r.data;
  }

  private requireCapability(cap: "snapshot" | "fork" | "pause"): void {
    if (!this.capabilities[cap]) {
      throw new ProviderValidationError(`provider ${this.name} does not support ${cap}`, {
        provider: this.name,
      });
    }
  }

  private status(c: FakeComputer): ComputerStatus {
    if (c.destroyed) return "destroyed";
    if (this.now() < c.readyAt) return "creating";
    if (c.failProvision) return "failed";
    return c.paused ? "paused" : "running";
  }

  private info(c: FakeComputer): ComputerInfo {
    return {
      id: c.id,
      provider: this.name,
      name: c.name,
      status: this.status(c),
      vcpu: c.vcpu,
      memoryMb: c.memoryMb,
      diskGb: c.diskGb,
      tags: [...c.tags],
      snapshotId: c.snapshotId,
      home: this.home,
      createdAt: c.createdAt,
      probe: null,
    };
  }

  private get(id: string): FakeComputer {
    const c = this.computers.get(id);
    if (!c || c.destroyed)
      throw new ProviderNotFoundError(`computer ${id} not found`, {
        provider: this.name,
        resource: id,
      });
    return c;
  }

  /** A computer that can take a call: running, or paused (resumed, as on Naïve). */
  private live(id: string): FakeComputer {
    const c = this.get(id);
    const s = this.status(c);
    if (s === "creating" || s === "failed") {
      throw new ProviderUnavailableError(`computer ${id} is ${s}`, {
        provider: this.name,
        resource: id,
      });
    }
    c.paused = false;
    return c;
  }

  private absPath(path: string): string {
    if (path === "~" || path.startsWith("~/")) path = this.home + path.slice(1);
    return posix.normalize(posix.isAbsolute(path) ? path : posix.join(this.home, path));
  }

  private readFsText(c: FakeComputer, path: string): string | undefined {
    const f = c.files.get(this.absPath(path));
    return f && dec.decode(f.data);
  }

  private writeFsText(c: FakeComputer, path: string, text: string, append: boolean): void {
    const abs = this.absPath(path);
    const prev = append ? c.files.get(abs) : undefined;
    const data = enc.encode((prev ? dec.decode(prev.data) : "") + text);
    c.files.set(abs, { data, mode: prev?.mode ?? 0o644 });
  }

  private findHandler(
    command: string,
  ): { handler: FakeExecHandler; match: RegExpExecArray | null } | undefined {
    for (const { matcher, handler } of this.handlers) {
      if (typeof matcher === "string") {
        if (matcher === command) return { handler, match: null };
      } else if (matcher instanceof RegExp) {
        matcher.lastIndex = 0;
        const m = matcher.exec(command);
        if (m) return { handler, match: m };
      } else if (matcher(command)) {
        return { handler, match: null };
      }
    }
    return undefined;
  }

  private async callHandler(
    c: FakeComputer,
    command: string,
    found: { handler: FakeExecHandler; match: RegExpExecArray | null },
  ): Promise<Required<FakeExecReply>> {
    const reply = await found.handler({
      command,
      match: found.match,
      computerId: c.id,
      home: this.home,
      readFile: (p) => this.readFsText(c, p),
      writeFile: (p, content, o) => this.writeFsText(c, p, content, o?.append ?? false),
    });
    const r = typeof reply === "string" ? { stdout: reply } : reply;
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? 0,
      durationMs: r.durationMs ?? 0,
    };
  }

  /** Run a whole command line: a matching handler, else the built-in mini shell. */
  private async runScript(
    c: FakeComputer,
    command: string,
    timeoutMs: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    virtualMs: number;
  }> {
    const whole = this.findHandler(command);
    if (whole) {
      const r = await this.callHandler(c, command, whole);
      if (r.durationMs > timeoutMs) {
        await realSleep(timeoutMs * this.timeScale);
        return {
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: 124,
          timedOut: true,
          virtualMs: timeoutMs,
        };
      }
      await realSleep(r.durationMs * this.timeScale);
      return { ...r, timedOut: false, virtualMs: r.durationMs };
    }

    const state = { stdout: "", stderr: "", virtualMs: 0 };
    let exitCode = 0;
    let parsed: FakeStatement[];
    try {
      parsed = parseFakeShell(command, this.home);
    } catch (e) {
      return {
        stdout: "",
        stderr: `sh: ${(e as Error).message}\n`,
        exitCode: 2,
        timedOut: false,
        virtualMs: 0,
      };
    }
    for (const st of parsed) {
      if (st.op === "&&" && exitCode !== 0) continue;
      if (st.op === "||" && exitCode === 0) continue;
      const res = await this.runStatement(c, st, timeoutMs - state.virtualMs);
      state.virtualMs += res.virtualMs;
      this.emit(c, st, state, res.stdout, res.stderr);
      if (res.timedOut) {
        return {
          stdout: state.stdout,
          stderr: state.stderr,
          exitCode: 124,
          timedOut: true,
          virtualMs: timeoutMs,
        };
      }
      exitCode = res.exitCode;
      if (res.exit) break;
    }
    return {
      stdout: state.stdout,
      stderr: state.stderr,
      exitCode,
      timedOut: false,
      virtualMs: state.virtualMs,
    };
  }

  private emit(
    c: FakeComputer,
    st: FakeStatement,
    state: { stdout: string; stderr: string },
    stdout: string,
    stderr: string,
  ): void {
    const errText = st.stderrToStdout ? "" : stderr;
    const outText = st.stderrToStdout ? stdout + stderr : stdout;
    if (st.stdoutToStderr) state.stderr += outText;
    else if (st.redirect) {
      if (st.redirect.path !== "/dev/null")
        this.writeFsText(c, st.redirect.path, outText, st.redirect.append);
    } else state.stdout += outText;
    state.stderr += errText;
  }

  private async runStatement(
    c: FakeComputer,
    st: FakeStatement,
    remainingMs: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    virtualMs: number;
    exit?: boolean;
  }> {
    const [cmd, ...args] = st.words;
    const ok = (stdout = "", exitCode = 0) => ({
      stdout,
      stderr: "",
      exitCode,
      timedOut: false,
      virtualMs: 0,
    });
    const fail = (stderr: string, exitCode = 1) => ({
      stdout: "",
      stderr,
      exitCode,
      timedOut: false,
      virtualMs: 0,
    });
    if (cmd === undefined) return ok();

    const found = this.findHandler(st.words.join(" "));
    if (found) {
      const r = await this.callHandler(c, st.words.join(" "), found);
      if (r.durationMs > remainingMs) {
        await realSleep(remainingMs * this.timeScale);
        return {
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: 124,
          timedOut: true,
          virtualMs: remainingMs,
        };
      }
      await realSleep(r.durationMs * this.timeScale);
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        timedOut: false,
        virtualMs: r.durationMs,
      };
    }

    switch (cmd) {
      case "echo": {
        const noNewline = args[0] === "-n";
        const words = noNewline ? args.slice(1) : args;
        return ok(words.join(" ") + (noNewline ? "" : "\n"));
      }
      case "cat": {
        let out = "";
        for (const p of args) {
          const t = this.readFsText(c, p);
          if (t === undefined)
            return { ...fail(`cat: ${p}: No such file or directory\n`), stdout: out };
          out += t;
        }
        return ok(out);
      }
      case "true":
      case "mkdir":
        return ok();
      case "false":
        return ok("", 1);
      case "exit": {
        const n = args[0] === undefined ? 0 : Number.parseInt(args[0], 10);
        return { ...ok("", Number.isNaN(n) ? 2 : n & 0xff), exit: true };
      }
      case "sleep": {
        const secs = Number.parseFloat(args[0] ?? "");
        if (!Number.isFinite(secs) || secs < 0)
          return fail(`sleep: invalid time interval '${args[0] ?? ""}'\n`);
        const ms = secs * 1000;
        if (ms > remainingMs) {
          await realSleep(remainingMs * this.timeScale);
          return { stdout: "", stderr: "", exitCode: 124, timedOut: true, virtualMs: remainingMs };
        }
        await realSleep(ms * this.timeScale);
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false, virtualMs: ms };
      }
      case "touch": {
        for (const p of args)
          if (this.readFsText(c, p) === undefined) this.writeFsText(c, p, "", false);
        return ok();
      }
      case "rm": {
        for (const p of args.filter((a) => !a.startsWith("-"))) {
          const abs = this.absPath(p);
          for (const k of [...c.files.keys()])
            if (k === abs || k.startsWith(`${abs}/`)) c.files.delete(k);
        }
        return ok();
      }
      case "test":
      case "[": {
        const a = cmd === "[" ? args.slice(0, -1) : args;
        if ((a[0] === "-f" || a[0] === "-e") && a[1] !== undefined)
          return ok("", this.readFsText(c, a[1]) === undefined ? 1 : 0);
        return fail(`${cmd}: unsupported expression in FakeProvider\n`, 2);
      }
      default:
        return fail(`sh: ${cmd}: command not found\n`, 127);
    }
  }
}

// ---------- the fake's mini shell parser ----------

interface FakeStatement {
  /** How this statement joins the previous one. */
  op: ";" | "&&" | "||";
  words: string[];
  redirect?: { path: string; append: boolean };
  stdoutToStderr: boolean;
  stderrToStdout: boolean;
}

type FakeToken = { kind: "word"; value: string } | { kind: "op"; value: string };

function tokenizeFakeShell(src: string, home: string): FakeToken[] {
  const tokens: FakeToken[] = [];
  let i = 0;
  const expand = (s: string) => s.replaceAll("${HOME}", home).replaceAll("$HOME", home);
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n") {
      i++;
      continue;
    }
    const rest = src.slice(i);
    const op = ["&&", "||", "2>&1", "1>&2", ">&2", ">>", ">", ";"].find((o) => rest.startsWith(o));
    if (op) {
      tokens.push({ kind: "op", value: op === "1>&2" ? ">&2" : op });
      i += op.length;
      continue;
    }
    if (ch === "|" || ch === "&" || ch === "<" || ch === "`" || ch === "(" || ch === ")") {
      throw new Error(
        `FakeProvider shell does not support '${ch}'; script this command with onExec()`,
      );
    }
    let word = "";
    let first = true;
    while (i < src.length && !" \t\n;&|<>".includes(src[i]!)) {
      const c = src[i]!;
      if (c === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new Error("unterminated single quote");
        word += src.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        let j = i + 1;
        let buf = "";
        while (j < src.length && src[j] !== '"') {
          if (src[j] === "\\" && j + 1 < src.length && '"\\$`'.includes(src[j + 1]!)) {
            buf += src[j + 1];
            j += 2;
          } else buf += src[j++];
        }
        if (j >= src.length) throw new Error("unterminated double quote");
        word += expand(buf);
        i = j + 1;
      } else if (c === "\\" && i + 1 < src.length) {
        word += src[i + 1];
        i += 2;
      } else {
        let j = i;
        while (j < src.length && !" \t\n;&|<>'\"\\".includes(src[j]!)) j++;
        let raw = src.slice(i, j);
        if (first && (raw === "~" || raw.startsWith("~/"))) raw = home + raw.slice(1);
        word += expand(raw);
        i = j;
      }
      first = false;
    }
    tokens.push({ kind: "word", value: word });
  }
  return tokens;
}

function parseFakeShell(src: string, home: string): FakeStatement[] {
  const out: FakeStatement[] = [];
  let cur: FakeStatement = { op: ";", words: [], stdoutToStderr: false, stderrToStdout: false };
  const tokens = tokenizeFakeShell(src, home);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "word") {
      cur.words.push(t.value);
    } else if (t.value === ";" || t.value === "&&" || t.value === "||") {
      out.push(cur);
      cur = { op: t.value, words: [], stdoutToStderr: false, stderrToStdout: false };
    } else if (t.value === ">" || t.value === ">>") {
      const target = tokens[++i];
      if (!target || target.kind !== "word") throw new Error(`syntax error near '${t.value}'`);
      cur.redirect = { path: target.value, append: t.value === ">>" };
    } else if (t.value === ">&2") {
      cur.stdoutToStderr = true;
    } else if (t.value === "2>&1") {
      cur.stderrToStdout = true;
    }
  }
  out.push(cur);
  return out.filter((s) => s.words.length > 0 || s.redirect);
}
