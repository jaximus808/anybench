// TDM-219 [19.3]: the two bash scripts the local proof runs in Docker, one container each, so the
// subject side and the scoring side stay apart as they do on Anybench computers (plan.md 17.2
// rule 5):
//
//   trial.sh   mounted: /kit = the kit WITHOUT gates/ and reference/ (plus the oracle overlay),
//              read-only; /out. Per (variant, workload): a fresh writable copy of the kit, the L3
//              workspace prep (input → EVAL_IN, instruction → EVAL_IN/instruction.md, setup.sh
//              builds EVAL_WS), then the oracle's verbs (the driver_patch copied over the
//              contender's driver) or, for do-nothing, nothing: the untouched workspace is frozen
//              to EVAL_OUT/workspace, as a coding agent's driver freezes it. `collect` globs go to
//              EVAL_OUT/artifacts. EVAL_OUT is /out/units/<variant>/<workload>/out.
//   gate.sh    mounted: /kit = gates/ and reference/ only, read-only; /out. Per unit and gate:
//              `check.sh <frozen-out> <workload> <gate.json>` with $AB_RUN (a clean-env
//              pass-through: there is one uid here) and $AB_RUN_DIR (a fresh copy of the outputs),
//              as packages/bench gate.ts calls it on a scoring computer.
//
// Records land under /out/units/<variant>/<workload>/: setup.exit, driver.exit, trial.log, out/,
// gates/<gate>/{check.exit,check.log,gate.json}. readLocalProofRecords + evaluateLocalProof turn
// them into the result. Both scripts run under bash 4+ (globstar) and need coreutils, cp and tar;
// git is used when present.
import { CLI_SCRIPT_SHEBANG, shQuote } from "../drivers/cli/shell.js";
import type { LocalProofPlan } from "./plan.js";

const COMMON = [
  "set -uo pipefail",
  "OUT=/out",
  // tmo <seconds> <cmd...>: coreutils timeout when present.
  'tmo() { local s="$1"; shift; if [ "$s" -gt 0 ] && command -v timeout > /dev/null 2>&1; then timeout -k 10 "$s" "$@"; else "$@"; fi; }',
  // Leave /out owned by the host user, so the host can read and delete it.
  'finish() { if [ -n "${HOST_UID:-}" ]; then chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" "$OUT" 2> /dev/null || true; fi; }',
  "trap finish EXIT",
];

/** The subject-side script (trial.sh). */
export function renderLocalProofTrialScript(plan: LocalProofPlan): string {
  const o = plan.oracle;
  const collect = plan.collect.map((g) => g.replace(/^\.\//, ""));
  const lines = [
    CLI_SCRIPT_SHEBANG,
    "# anybench local proof, subject side (TDM-219). Rendered by @anybench/kit renderLocalProofTrialScript.",
    ...COMMON,
    "shopt -s globstar dotglob nullglob",
    "",
    "# collect_globs: the kit's collect globs (relative to EVAL_WS) into EVAL_OUT/artifacts.",
    "collect_globs() {",
    '  [ "$#" -gt 0 ] || return 0',
    '  (cd "$EVAL_WS" || exit 0',
    '   for g in "$@"; do',
    "     # shellcheck disable=SC2086",
    "     for f in $g; do",
    '       if [ -f "$f" ]; then mkdir -p "$EVAL_OUT/artifacts/$(dirname "$f")" && cp "$f" "$EVAL_OUT/artifacts/$f"',
    '       elif [ -d "$f" ]; then find "$f" -type f | while IFS= read -r x; do mkdir -p "$EVAL_OUT/artifacts/$(dirname "$x")" && cp "$x" "$EVAL_OUT/artifacts/$x"; done; fi',
    "     done",
    "   done)",
    "}",
    "",
    "# trial <variant> <workload> <input> <instruction> <setup> <timeout_s>",
    "trial() {",
    '  local variant="$1" w="$2" input="$3" instr="$4" setup="$5" tmo_s="$6"',
    '  local u="$OUT/units/$variant/$w" b rc',
    '  rm -rf "$u"; mkdir -p "$u/out"',
    '  b="$(mktemp -d /tmp/abproof.XXXXXX)"',
    '  cp -R /kit "$b/kit"',
    '  export EVAL_IN="$b/in" EVAL_WS="$b/ws" EVAL_OUT="$u/out" EVAL_SECRETS="$b/secrets.env" EVAL_PHASE=run',
    '  export WORKLOAD="$w" EVAL_WORKLOAD="$w" HOME="$b/home" TMPDIR="$b/tmp"',
    '  mkdir -p "$EVAL_IN" "$EVAL_WS" "$HOME" "$TMPDIR"; : > "$EVAL_SECRETS"; chmod 600 "$EVAL_SECRETS"',
    '  cd "$b/kit" || return 0',
    '  echo "[proof] $variant $w: setup"',
    "  rc=0",
    "  {",
    '    if [ -d "$input" ]; then cp -R "$input/." "$EVAL_IN/"; fi',
    '    if [ -n "$instr" ]; then cp "$instr" "$EVAL_IN/instruction.md"; fi',
    '    if [ -n "$setup" ]; then',
    '      tmo "$tmo_s" bash "$setup" "$EVAL_WS"',
    "    else",
    '      cp -R "$EVAL_IN/." "$EVAL_WS/" && rm -f "$EVAL_WS/instruction.md" &&',
    '        if command -v git > /dev/null 2>&1; then git -C "$EVAL_WS" init -q && git -C "$EVAL_WS" add -A && git -C "$EVAL_WS" -c user.name=kit -c user.email=kit@anybench.invalid -c commit.gpgsign=false commit -qm start; fi',
    "    fi",
    '  } >> "$u/trial.log" 2>&1 || rc=$?',
    '  echo "$rc" > "$u/setup.exit"',
    '  if [ "$rc" != 0 ]; then echo "[proof] $variant $w: setup failed (exit $rc)"; rm -rf "$b"; return 0; fi',
    '  if [ "$variant" = oracle ]; then',
    '    echo "[proof] $variant $w: driver"',
    "    rc=0",
    "    {",
    '      [ -z "$V_START" ] || tmo "$tmo_s" bash -c "$V_START"',
    '    } >> "$u/trial.log" 2>&1 || rc=$?',
    '    if [ "$rc" = 0 ]; then { [ -z "$V_READY" ] || tmo "$tmo_s" bash -c "$V_READY"; } >> "$u/trial.log" 2>&1 || rc=$?; fi',
    '    if [ "$rc" = 0 ]; then tmo "$tmo_s" bash -c "$V_RUN" >> "$u/trial.log" 2>&1 < /dev/null || rc=$?; fi',
    '    { [ -z "$V_STOP" ] || tmo 120 bash -c "$V_STOP"; } >> "$u/trial.log" 2>&1 || true',
    '    echo "$rc" > "$u/driver.exit"',
    '    [ "$rc" = 0 ] || echo "[proof] $variant $w: driver exited $rc"',
    "  else",
    "    # do-nothing: no driver runs; freeze the untouched workspace, as an agent driver would.",
    '    mkdir -p "$EVAL_OUT/workspace" && cp -R "$EVAL_WS/." "$EVAL_OUT/workspace/"',
    "  fi",
    `  collect_globs ${collect.map(shQuote).join(" ")} >> "$u/trial.log" 2>&1 || true`,
    '  cd / && rm -rf "$b"',
    "}",
    "",
    "# The oracle overlay: the driver_patch replaces the contender's driver, as on Anybench computers.",
    `export V_START=${shQuote(o.verbs.start ?? "")} V_READY=${shQuote(o.verbs.ready ?? "")} V_RUN=${shQuote(o.verbs.run)} V_STOP=${shQuote(o.verbs.stop ?? "")}`,
  ];
  const call = (variant: string, w: LocalProofPlan["workloads"][number]) =>
    `trial ${shQuote(variant)} ${shQuote(w.id)} ${shQuote(w.input)} ${shQuote(w.instruction ?? "")} ${shQuote(w.setup ?? "")} ${w.timeoutS}`;
  lines.push("(");
  for (const [k, val] of Object.entries(o.env)) lines.push(`  export ${k}=${shQuote(val)}`);
  for (const w of plan.workloads) lines.push(`  ${call("oracle", w)}`);
  lines.push(")");
  lines.push("(");
  for (const w of plan.workloads) lines.push(`  ${call("do-nothing", w)}`);
  lines.push(")");
  lines.push('echo "[proof] trials done"', "");
  return lines.join("\n");
}

/** The scoring-side script (gate.sh). */
export function renderLocalProofGateScript(plan: LocalProofPlan): string {
  const lines = [
    CLI_SCRIPT_SHEBANG,
    "# anybench local proof, scoring side (TDM-219). Rendered by @anybench/kit renderLocalProofGateScript.",
    ...COMMON,
    "AB_RUN=/tmp/ab-run-local.sh",
    // One uid here: AB_RUN is a clean-env pass-through; on a scoring computer it switches uid.
    `printf '%s\\n' '#!/usr/bin/env bash' 'set -u' 'h="\${AB_RUN_HOME:-/tmp}"' 'exec env -i PATH="\${PATH:-/usr/local/bin:/usr/bin:/bin}" HOME="$h" TMPDIR="$h" LC_ALL=C LANG=C "$@"' > "$AB_RUN"`,
    'chmod 755 "$AB_RUN"',
    "",
    "# gate <variant> <workload> <gate> <check> <timeout_s>",
    "gate() {",
    '  local variant="$1" w="$2" g="$3" check="$4" tmo_s="$5"',
    '  local u="$OUT/units/$variant/$w" gd b rc',
    '  [ -f "$u/setup.exit" ] && [ "$(cat "$u/setup.exit")" = 0 ] || return 0',
    '  gd="$u/gates/$g"; rm -rf "$gd"; mkdir -p "$gd"',
    '  b="$(mktemp -d /tmp/abgate.XXXXXX)"; mkdir -p "$b/frozen" "$b/run" "$b/home" "$b/verdict"',
    '  cp -R "$u/out/." "$b/frozen/"; cp -R "$u/out/." "$b/run/"',
    '  echo "[proof] $variant $w: gate $g"',
    "  rc=0",
    '  (cd "$b/run" && tmo "$tmo_s" env -i PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}" HOME="$b/home" AB_RUN="$AB_RUN" AB_RUN_DIR="$b/run" AB_RUN_HOME="$b/home" bash "/kit/$check" "$b/frozen" "$w" "$b/verdict/gate.json" < /dev/null) > "$gd/check.log" 2>&1 || rc=$?',
    '  echo "$rc" > "$gd/check.exit"',
    '  if [ -f "$b/verdict/gate.json" ]; then cp "$b/verdict/gate.json" "$gd/gate.json"; fi',
    '  cd / && rm -rf "$b"',
    "}",
    "",
  ];
  const timeoutOf = new Map(plan.gates.map((g) => [g.id, g] as const));
  const oracleGates = new Set(plan.oracle.gates);
  for (const variant of ["oracle", "do-nothing"] as const) {
    for (const w of plan.workloads) {
      for (const g of plan.gates) {
        if (variant === "oracle" && !oracleGates.has(g.id)) continue;
        const gp = timeoutOf.get(g.id)!;
        lines.push(
          `gate ${shQuote(variant)} ${shQuote(w.id)} ${shQuote(g.id)} ${shQuote(gp.check)} ${gp.timeoutS}`,
        );
      }
    }
  }
  lines.push('echo "[proof] gates done"', "");
  return lines.join("\n");
}
