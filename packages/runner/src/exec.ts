// Running driver verbs: a shell command in its own process group, output redacted line by line
// into stdout.log / stderr.log, killed (whole group) when it overruns its cap or the trial is
// cancelled.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import type { Redactor } from "@anybench/core";

/** Longest partial line held back for redaction before it is written anyway. */
export const MAX_LINE_BYTES = 1024 * 1024;

/**
 * Appends redacted text to a file. Redaction runs on whole lines (a secret split across two
 * chunks is still caught); a partial line is held until its newline or MAX_LINE_BYTES.
 */
export class RedactingLineWriter {
  private readonly stream: WriteStream;
  private partial = "";
  private closing: Promise<void> | null = null;
  bytes = 0;
  /** Gets exactly the (redacted) text appended to the file, e.g. for live log chunks. */
  onWrite: ((text: string) => void) | null = null;
  /** Gets each redacted line without the verb tag, e.g. for the stream-json token meter. */
  onLine: ((line: string) => void) | null = null;

  constructor(
    path: string,
    private readonly redact: Redactor,
  ) {
    this.stream = createWriteStream(path, { flags: "a" });
  }

  write(chunk: Buffer | string, prefix = ""): void {
    this.partial += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = this.partial.indexOf("\n")) !== -1) {
      this.emit(prefix, this.partial.slice(0, nl + 1));
      this.partial = this.partial.slice(nl + 1);
    }
    if (this.partial.length > MAX_LINE_BYTES) {
      this.emit(prefix, this.partial);
      this.partial = "";
    }
  }

  /** Write any held partial line (after a verb exits). */
  flushPartial(prefix = ""): void {
    if (this.partial.length > 0) {
      this.emit(prefix, `${this.partial}\n`);
      this.partial = "";
    }
  }

  private emit(prefix: string, line: string): void {
    if (this.closing) return;
    const out = this.redact(prefix + line);
    this.bytes += Buffer.byteLength(out);
    this.stream.write(out);
    this.onWrite?.(out);
    if (this.onLine) {
      // The tag holds no secret, so redaction leaves it as the prefix.
      this.onLine(out.startsWith(prefix) ? out.slice(prefix.length) : out);
    }
  }

  /** Idempotent; later writes are dropped. */
  close(): Promise<void> {
    if (!this.closing) {
      this.flushPartial();
      this.closing = new Promise((resolve) => this.stream.end(resolve));
    }
    return this.closing;
  }
}

export function defaultShell(): string {
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

export interface VerbResult {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  /** Killed because `abort` resolved (e.g. the token cap was crossed). */
  aborted: boolean;
}

export interface RunVerbOptions {
  /** Shell command; `args` become $1, $2, ... */
  command: string;
  args?: string[];
  shell: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdout: RedactingLineWriter;
  stderr: RedactingLineWriter;
  /** Tag prepended to each output line, e.g. "[run] ". */
  tag?: string;
  /** Resolves when the trial is cancelled; the verb's process group is killed. */
  cancelled?: Promise<void>;
  /** Resolves when the runner wants this verb stopped for another reason (token cap). */
  abort?: Promise<void>;
  /** Grace between SIGTERM and SIGKILL. */
  killGraceMs?: number;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** Run one verb to completion (or until its cap / cancellation). Never throws on a non-zero exit. */
export function runVerb(opts: RunVerbOptions): Promise<VerbResult> {
  const started = Date.now();
  const tag = opts.tag ?? "";
  return new Promise((resolve) => {
    // detached: the verb leads its own process group, so killing -pid takes its children too.
    const child = spawn(opts.shell, ["-c", opts.command, "anybench-verb", ...(opts.args ?? [])], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let cancelled = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const terminate = () => {
      if (child.pid === undefined || settled) return;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      }, opts.killGraceMs ?? 5000);
      killTimer.unref();
    };

    const capTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);
    capTimer.unref();

    void opts.cancelled?.then(() => {
      if (settled) return;
      cancelled = true;
      terminate();
    });
    void opts.abort?.then(() => {
      if (settled) return;
      aborted = true;
      terminate();
    });

    child.stdout.on("data", (c: Buffer) => opts.stdout.write(c, tag));
    child.stderr.on("data", (c: Buffer) => opts.stderr.write(c, tag));

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(capTimer);
      if (killTimer) clearTimeout(killTimer);
      // Stragglers left in the group (backgrounded by the verb) are not ours to keep.
      if (child.pid !== undefined && (timedOut || cancelled || aborted))
        killGroup(child.pid, "SIGKILL");
      opts.stdout.flushPartial(tag);
      opts.stderr.flushPartial(tag);
      resolve({
        exitCode,
        signal,
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
        aborted,
      });
    };

    child.on("error", (err) => {
      opts.stderr.write(`runner: cannot start verb: ${err.message}\n`, tag);
      finish(127, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    // A verb that backgrounds a daemon (`start`) leaves the pipes open, so `close` may never come:
    // finish shortly after the shell itself exits and stop reading.
    child.on("exit", (code, signal) => {
      setTimeout(() => {
        finish(code, signal);
        child.stdout.destroy();
        child.stderr.destroy();
      }, 200);
    });
  });
}
