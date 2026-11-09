// `claude` for the league's Claude Code setups (TDM-228 [21.2]): runs the real Claude Code
// (AB_REAL_CLAUDE, set by ./driver.sh) and applies ./policy.mjs. Started through ./bin/claude,
// which adapters/claude-code/driver.sh (E18's driver, byte for byte) finds first on PATH.
//
//   - `claude -p --output-format stream-json ... < task` (the driver's run): the stream passes
//     through to stdout line by line, live (the driver's tap and the runner's token cap read it).
//     When the process exits and `decide` says its final message waits on the user, the same
//     session is resumed with the policy's REPLY (`-p REPLY --resume <id>` + the same flags, no
//     stdin), at most MAX_AUTO_ANSWERS times. Exit status: the last process's.
//   - anything else (`claude --version`, ...): exec-like pass-through.
//
// Events it adds to the stream (one JSON line each, `type: "system"`): `anybench_headless_policy`
// once at the start (policy id, reply, cap), `anybench_auto_answer` before each resume (n, the
// detector's reason, the session id), `anybench_auto_answer_cap` when a session still waited at
// the cap. A TERM/INT/HUP (the driver's wall-clock `timeout`) goes to the running process and
// stops the policy: nothing is resumed after a signal.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import {
  EVENT_AUTO_ANSWER,
  EVENT_CAP,
  EVENT_POLICY,
  MAX_AUTO_ANSWERS,
  POLICY_ID,
  REPLY,
  decide,
  isPolicyRun,
  resumeArgs,
} from "./policy.mjs";

const real = process.env.AB_REAL_CLAUDE;
if (!real) {
  process.stderr.write("headless-policy claude: AB_REAL_CLAUDE is not set (adapters/headless-policy/driver.sh sets it)\n");
  process.exit(127);
}
const argv = process.argv.slice(2);
let child = null;
let signalled = null;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    signalled = sig;
    if (child && child.exitCode === null) child.kill(sig);
  });
}

const write = (line) => {
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    // stdout closed (the driver's pipe is gone): stop the run.
    if (child) child.kill("SIGTERM");
  }
};
process.stdout.on("error", () => {
  signalled ??= "EPIPE";
  if (child && child.exitCode === null) child.kill("SIGTERM");
});
const event = (subtype, fields) =>
  write(JSON.stringify({ type: "system", subtype, ...fields, timestamp: new Date().toISOString() }));

/** One real `claude` process; resolves with its exit status and its last `result` event. */
function runOnce(args, passthrough, stdin) {
  return new Promise((resolve) => {
    child = spawn(real, args, { stdio: passthrough ? "inherit" : [stdin, "pipe", "inherit"] });
    let result = null;
    let sessionId = null;
    let buf = "";
    const take = (line) => {
      write(line);
      if (!line.includes('"type"')) return;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (!e || typeof e !== "object") return;
      if (typeof e.session_id === "string") sessionId = e.session_id;
      if (e.type === "result") result = e;
    };
    if (!passthrough) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          take(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stdout.on("end", () => {
        if (buf !== "") take(buf);
        buf = "";
      });
    }
    child.on("error", (err) => {
      process.stderr.write(`headless-policy claude: cannot start ${real}: ${err.message}\n`);
      resolve({ code: 127, result: null, sessionId });
    });
    child.on("close", (code, signal) => {
      const bySignal = signal ? 128 + (constants.signals[signal] ?? 15) : 1;
      resolve({ code: code ?? bySignal, result, sessionId });
    });
  });
}

async function main() {
  if (!isPolicyRun(argv)) {
    const r = await runOnce(argv, true);
    process.exitCode = r.code;
    return;
  }
  event(EVENT_POLICY, { policy: POLICY_ID, reply: REPLY, max: MAX_AUTO_ANSWERS });
  let args = argv;
  let fired = 0;
  for (;;) {
    // The first process reads the task from our stdin (the driver's `< task`); a resumed one
    // gets the reply on argv and no stdin.
    const r = await runOnce(args, false, fired === 0 ? "inherit" : "ignore");
    // process.exitCode, not process.exit(): stdout to a pipe is asynchronous on macOS, and
    // exiting at once could drop the last lines.
    if (signalled) {
      process.exitCode = r.code === 0 ? 143 : r.code;
      return;
    }
    const d = decide(r.result, fired);
    if (!d.fire) {
      if (d.cap) event(EVENT_CAP, { policy: POLICY_ID, n: fired, asked: d.asked, session_id: r.result.session_id });
      process.exitCode = r.code;
      return;
    }
    fired++;
    const sessionId = r.result.session_id;
    event(EVENT_AUTO_ANSWER, { policy: POLICY_ID, n: fired, reason: d.reason, reply: REPLY, session_id: sessionId });
    args = resumeArgs(argv, sessionId);
  }
}

main();
