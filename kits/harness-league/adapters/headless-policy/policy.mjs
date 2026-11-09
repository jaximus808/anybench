// The league's headless policy (TDM-228 [21.2]): what happens when a Claude Code session stops to
// ask the user something. One policy, the same for every Claude Code setup (A, B, G, S), applied
// by ./claude (a wrapper around the real `claude`, see ./driver.sh). Pure functions of the
// session's own stream-json: no contender id, no workspace, no gate, no hidden test goes in.
//
// Why it exists: in `claude -p` (Claude Code 2.1.319) there is no AskUserQuestion tool, not even
// behind ToolSearch ("No matching deferred tools found"), so a skill that wants to ask asks in
// plain text, and a plain-text question ends a `-p` run with result `success` and the work
// undone (docs/findings/headless-policy.md). gstack's skills render a prose decision brief and
// stop; Superpowers waits for the design to be approved ("Nothing gets built until your human
// partner approves the design doc"). Scoring that as a failure would measure our harness, not
// the tool; a reply only one tool gets would be a one-sided assist (plan.md 17.2 rule 4).
//
// The policy: when a session's final message waits on the user (`awaitingUser` below), the
// wrapper resumes that same session (`claude -p <REPLY> --resume <session id>`, every other
// flag unchanged) with the fixed REPLY, at most MAX_AUTO_ANSWERS times per trial. Nothing is
// added to any prompt, so a setup that never asks runs exactly as it would without the policy.
// Each firing is a `system/anybench_auto_answer` event in stream.jsonl, which the stream-json
// collector counts as `questions_auto_answered`.

/** Bumped whenever REPLY, MAX_AUTO_ANSWERS or the detector changes meaning. */
export const POLICY_ID = "headless-v1";

/** What the simulated user says, every time, to every setup. */
export const REPLY = "Yes, approved. Proceed with your recommended option and complete the task.";

/**
 * Most auto-answers per trial. Superpowers' documented flow has three stops (design approval,
 * plan review with the execution method, the finishing-a-branch choice) and gstack asks once per
 * decision brief; 8 leaves headroom and still ends a session that would ask forever.
 */
export const MAX_AUTO_ANSWERS = 8;

/** The stream-json event types the wrapper writes (bench's stream-json collector reads them). */
export const EVENT_POLICY = "anybench_headless_policy";
export const EVENT_AUTO_ANSWER = "anybench_auto_answer";
export const EVENT_CAP = "anybench_auto_answer_cap";

/** How much of the end of the final message the detector reads. */
const TAIL_CHARS = 1500;

/**
 * Phrases that mean "I am waiting for you", tested on the closing part of the final message.
 * Offers after finished work ("let me know if you'd like me to ...") are deliberately absent.
 */
const WAITING = [
  ["reply-with", /\b(?:reply|respond|answer)\s+(?:with|by|using)\b/i],
  ["reply-choice", /\b(?:[Rr]eply|[Rr]espond|[Aa]nswer)\s+[`"'“]?(?:[A-H]|[1-9])\b(?![-\w])/],
  ["say-go", /\bsay\s+[`"'“]?go\b/i],
  [
    "waiting-for-you",
    /\b(?:wait(?:ing)?|awaiting)\s+(?:for\s+)?(?:your|you\b|the user|confirmation|approval|input|a reply|an answer)/i,
  ],
  [
    "once-you",
    /\bonce you(?:'ve| have)?\s+(?:confirm|approve|reply|answer|choose|pick|decide|say|review|sign)/i,
  ],
  [
    "please-decide",
    /\b(?:please|can you|could you)\s+(?:confirm|choose|pick|select|approve|decide|tell me)\b/i,
  ],
  ["let-me-know-which", /\blet me know (?:which|whether|how you(?:'d| would)? (?:like|want))/i],
  ["before-i", /\bbefore I (?:start|begin|build|proceed|implement|write|go)\b/i],
  ["approve-the", /\b(?:approve|sign off on)\s+(?:the|this|my)\b/i],
  ["gstack-blocked", /\bBLOCKED\s*[—–-]+\s*AskUserQuestion\b/i],
  ["needs-context", /\bSTATUS:\s*NEEDS_CONTEXT\b/],
];

/** A line's text without markdown decoration around its end (`**...?**`, `_..._`, quotes, `)`). */
function bare(line) {
  return line
    .trim()
    .replace(/[\s*_`"'”’)\]>]+$/u, "")
    .trim();
}

/**
 * Does this final assistant message wait on the user? `{ awaiting, reason }`: a question mark
 * ending one of the last three non-empty lines, or a waiting phrase in the last TAIL_CHARS.
 */
export function awaitingUser(text) {
  if (typeof text !== "string" || text.trim() === "") return { awaiting: false, reason: "empty" };
  const tail = text.slice(-TAIL_CHARS);
  const lines = tail
    .split("\n")
    .map(bare)
    .filter((l) => l !== "");
  if (lines.slice(-3).some((l) => l.endsWith("?"))) return { awaiting: true, reason: "question" };
  for (const [reason, re] of WAITING) if (re.test(tail)) return { awaiting: true, reason };
  return { awaiting: false, reason: "no-question" };
}

/**
 * What the wrapper does after one `claude -p` process exits. `result` is that process's last
 * `result` event (or null), `fired` the auto-answers already given in this trial.
 * `{ fire: true, reason }` resumes the session with REPLY; `{ fire: false, reason }` stops.
 */
export function decide(result, fired, max = MAX_AUTO_ANSWERS) {
  if (!result || typeof result !== "object") return { fire: false, reason: "no-result" };
  if (result.subtype !== "success" || result.is_error === true)
    return { fire: false, reason: `result-${String(result.subtype ?? "error")}` };
  if (typeof result.session_id !== "string" || result.session_id === "")
    return { fire: false, reason: "no-session-id" };
  const a = awaitingUser(result.result);
  if (!a.awaiting) return { fire: false, reason: a.reason };
  if (fired >= max) return { fire: false, reason: "cap", cap: true, asked: a.reason };
  return { fire: true, reason: a.reason };
}

/**
 * The flags of a policy run, without `-p` and its prompt. adapters/claude-code/driver.sh passes
 * the task on stdin (`claude -p --output-format stream-json ... < task`, TDM-239: one argv string
 * is capped at 128 KiB on Linux); a prompt given as `-p <prompt>` is dropped the same way.
 */
export function runFlags(argv) {
  return argv[1] !== undefined && !argv[1].startsWith("-") ? argv.slice(2) : argv.slice(1);
}

/**
 * The argv of the resumed process: the same flags, the reply as the prompt, `--resume <id>`.
 * (The reply is short, so it goes on argv; the resumed process gets no stdin.)
 */
export function resumeArgs(argv, sessionId) {
  if (!isPolicyRun(argv)) throw new Error("not a `claude -p --output-format stream-json` run");
  return ["-p", REPLY, "--resume", sessionId, ...runFlags(argv)];
}

/**
 * The runs the policy applies to: the shape adapters/claude-code/driver.sh starts
 * (`claude -p [<prompt>] --output-format stream-json ...`), never a resume or a continue of its
 * own. Anything else (`claude --version`, `claude plugin list`, ...) passes through untouched.
 */
export function isPolicyRun(argv) {
  if (argv.length < 3 || argv[0] !== "-p") return false;
  const i = argv.indexOf("--output-format");
  if (i < 1 || argv[i + 1] !== "stream-json") return false;
  return !argv.some((a) => a === "--resume" || a === "-r" || a === "--continue" || a === "-c");
}
