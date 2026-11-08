"use client";
// The New run screen (TDM-101, guided flow): one step at a time. 1 What did you build? 2 What do
// you want to find out? 3 What should it be compared against? 4 Review and start. Only 1 and 2 are
// required. Once a GitHub repo is in, Anybench reads it (runs.suggest, one bounded Naïve session)
// and proposes the question, the alternatives and the options; the user edits and confirms all of
// it, and if the suggester fails the flow carries on by hand without saying so.
// Submits runs.create with an Idempotency-Key and opens /runs/[id]. Creating a run is free; the
// estimate shows on the run page and Go is where the billing gate applies.
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { ApiClient, SuggestedAlternative } from "@anybench/core";
import { api } from "../../../lib/api";
import {
  comparedNames,
  compareSummary,
  EXAMPLE_QUESTIONS,
  optionsSummary,
  repoConfirmation,
  sourceSummary,
  stepReady,
  STEPS,
  SUGGEST_CLIENT_TIMEOUT_MS,
  suggestBody,
  type ChosenFiles,
  type StepMeta,
  type StepNo,
  type SuggestState,
} from "./flow";
import {
  APPROVALS_LABEL,
  buildCreateRunBody,
  describeError,
  EMPTY_FORM,
  formatBytes,
  newIdempotencyKey,
  RUNS_PER_SETUP_MAX,
  RUNS_PER_SETUP_MIN,
  SIGNIN_NEW_RUN,
  safeHttpsUrl,
  uploadFile,
  uploadSizeError,
  type ApprovalsPolicy,
  type NewRunForm as FormState,
  type PutFetch,
  type SourceKind,
  type SubmitFailure,
  type UploadedIds,
} from "./new-run";
import styles from "./new-run.module.css";

const SOURCE_LABEL: Readonly<Record<SourceKind, string>> = {
  github: "GitHub repo",
  binary: "Binary + docs",
  claude_setup: "Claude Code setup",
};

export interface NewRunFormProps {
  /** Injected in tests; defaults to the cookie-session client. */
  client?: ApiClient;
  /** PUT to presigned upload URLs; injected in tests. */
  put?: PutFetch;
}

export function NewRunForm({ client: injected, put }: NewRunFormProps) {
  const router = useRouter();
  const client = injected ?? api();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [files, setFiles] = useState<ChosenFiles>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The furthest step revealed, and the one step that is open (the rest are one-line summaries).
  const [stage, setStage] = useState<StepNo>(1);
  const [open, setOpen] = useState<StepNo>(1);
  const [announce, setAnnounce] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Anybench's reading of the repo, and what the user kept of it.
  const [suggest, setSuggest] = useState<SuggestState>({ status: "idle" });
  const [kept, setKept] = useState<SuggestedAlternative[]>([]);
  const [questionSuggested, setQuestionSuggestedState] = useState(false);
  const [optionsSuggested, setOptionsSuggested] = useState(false);
  // Kept in step with state from event handlers, for the async suggest callback.
  const latest = useRef({ question: "", questionSuggested: false, runs: false, approvals: false });
  const suggestSeq = useRef(0);
  // One key per attempt: a retry of the same form reuses it, any edit starts a new one.
  const idempotencyKey = useRef<string | null>(null);
  // Uploads already finished for this exact file, so a retry doesn't upload twice.
  const uploaded = useRef(new Map<File, string>());
  const formRef = useRef<HTMLFormElement>(null);
  // Where focus goes after the open step changes (null on first paint: the repo field autofocuses).
  const focusStep = useRef<StepNo | null>(null);

  useEffect(() => {
    let live = true;
    client.auth.me().catch((err: unknown) => {
      if (live && describeError(err).kind === "signed_out") router.replace(SIGNIN_NEW_RUN);
    });
    return () => {
      live = false;
    };
  }, [client, router]);

  useEffect(() => {
    const n = focusStep.current;
    if (n === null) return;
    focusStep.current = null;
    const root = formRef.current;
    const field =
      n === 1
        ? root?.querySelector<HTMLElement>("[data-first-field]")
        : n === 2
          ? root?.querySelector<HTMLElement>("#nr-question")
          : null;
    (field ?? root?.querySelector<HTMLElement>(`#nr-step-${n}-title`))?.focus();
  }, [open, form.sourceKind]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    idempotencyKey.current = null;
    if (key === "question") latest.current.question = value as string;
    setForm((f) => ({ ...f, [key]: value }));
  }
  function setQuestionSuggested(v: boolean) {
    latest.current.questionSuggested = v;
    setQuestionSuggestedState(v);
  }
  function setFile(key: keyof ChosenFiles, file: File | undefined) {
    idempotencyKey.current = null;
    setFiles((f) => ({ ...f, [key]: file }));
    // Checked from file.size alone, before any byte is read.
    const tooBig = file ? uploadSizeError(file.size, FILE_PURPOSE[key]) : null;
    setErrors(tooBig ? [tooBig] : []);
  }
  function chooseSource(kind: SourceKind) {
    update("sourceKind", kind);
    setErrors([]);
    focusStep.current = 1;
  }

  function openStep(n: StepNo, how: "next" | "edit") {
    const meta = STEPS[n - 1]!;
    setOpen(n);
    setStage((s) => (n > s ? n : s));
    setErrors([]);
    focusStep.current = n;
    const tag = n === 4 ? "" : meta.required ? " Required." : " Optional.";
    setAnnounce(`${how === "edit" ? "Editing" : "Now"} step ${n} of 4: ${meta.title}${tag}`);
  }

  /** The step Next goes to: the next one, or straight back to the furthest one when editing. */
  function nextTarget(from: StepNo): StepNo {
    const after = (from + 1) as StepNo;
    if (stage <= from) return after;
    for (let s = after; s < stage; s = (s + 1) as StepNo) if (!stepReady(s, form, files)) return s;
    return stage;
  }

  function advance(from: StepNo) {
    if (from >= 4 || !stepReady(from, form, files)) return;
    let target = nextTarget(from);
    // A different repo means a fresh suggestion: show it rather than jump past it.
    if (from === 1 && startSuggest() && target > 2) target = 2;
    openStep(target, "next");
  }

  /** Ask Anybench to read the repo. Returns true when a new reading started. */
  function startSuggest(): boolean {
    const req = suggestBody(form);
    if (!req) return false;
    if (suggest.status !== "idle" && suggest.key === req.key) return false;
    const seq = ++suggestSeq.current;
    setSuggest({ status: "loading", key: req.key });
    const timer = setTimeout(() => {
      if (suggestSeq.current === seq) setSuggest({ status: "failed", key: req.key });
    }, SUGGEST_CLIENT_TIMEOUT_MS);
    client.runs
      .suggest({ body: req.body })
      .then(({ suggestion }) => {
        if (suggestSeq.current !== seq) return;
        const l = latest.current;
        // Never overwrite what the user typed; replace only an earlier suggestion left as is.
        const fill = !l.question.trim() || l.questionSuggested;
        const top = suggestion.questions[0];
        setSuggest({ status: "ready", key: req.key, data: suggestion });
        setKept(suggestion.alternatives);
        setForm((f) => ({
          ...f,
          ...(fill && top ? { question: top } : {}),
          ...(l.runs ? {} : { runsPerSetup: suggestion.options.runs_per_setup }),
          ...(l.approvals ? {} : { approvals: suggestion.options.approvals }),
        }));
        if (fill && top) {
          l.question = top;
          setQuestionSuggested(true);
        }
        idempotencyKey.current = null;
        setOptionsSuggested(!l.runs || !l.approvals);
        setAnnounce(
          fill
            ? "Anybench read your repo and suggested a question. Edit it or pick another."
            : "Anybench read your repo. Its suggestions are below your question.",
        );
      })
      .catch(() => {
        // Silent fallback: the screen carries on by hand.
        if (suggestSeq.current === seq) setSuggest({ status: "failed", key: req.key });
      })
      .finally(() => clearTimeout(timer));
    return true;
  }

  const currentKey = suggestBody(form)?.key;
  const active = suggest.status !== "idle" && suggest.key === currentKey ? suggest : null;
  const suggestion = active?.status === "ready" ? active.data : null;
  const keptNow = suggestion ? kept : [];
  const names = comparedNames(keptNow, form.contenders);

  async function ensureUploaded(file: File | undefined, purpose: Parameters<typeof uploadFile>[2]) {
    if (!file) return undefined;
    const done = uploaded.current.get(file);
    if (done) return done;
    setBusy(`Uploading ${file.name}…`);
    const id = await uploadFile(client, file, purpose, put);
    uploaded.current.set(file, id);
    return id;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Enter in a field before the review step means Next, not submit.
    if (open !== 4) {
      advance(open);
      return;
    }
    if (busy) return;
    setFailure(null);
    // Kept suggestions ride along with the typed setups, through the same composeQuestion.
    const sent: FormState = { ...form, contenders: names };
    const precheck = buildCreateRunBody(sent, placeholderUploads(form.sourceKind, files));
    const sizeErrors = chosenFiles(form.sourceKind, files)
      .map(([key, file]) => uploadSizeError(file.size, FILE_PURPOSE[key]))
      .filter((m): m is string => m !== null);
    if (!precheck.ok || sizeErrors.length > 0) {
      setErrors([...sizeErrors, ...(precheck.ok ? [] : precheck.errors)]);
      return;
    }
    setErrors([]);
    try {
      const ids: UploadedIds = {};
      if (form.sourceKind === "binary") {
        const binary = await ensureUploaded(files.binary, "binary");
        const docs = await ensureUploaded(files.docs, "docs");
        if (binary) ids.binary = binary;
        if (docs) ids.docs = docs;
      } else if (form.sourceKind === "claude_setup") {
        const setup = await ensureUploaded(files.claudeSetup, "claude_setup");
        if (setup) ids.claudeSetup = setup;
      }
      const built = buildCreateRunBody(sent, ids);
      if (!built.ok) {
        setErrors(built.errors);
        setBusy(null);
        return;
      }
      idempotencyKey.current ??= newIdempotencyKey();
      setBusy("Starting the run…");
      const { run } = await client.runs.create({
        headers: { "idempotency-key": idempotencyKey.current },
        body: built.body,
      });
      router.push(`/runs/${run.id}`);
    } catch (err) {
      const f = describeError(err);
      setBusy(null);
      if (f.kind === "signed_out") {
        router.replace(SIGNIN_NEW_RUN);
        return;
      }
      setFailure(f);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (open < 4) advance(open);
    else formRef.current?.requestSubmit();
  }

  const alerts = <Alerts errors={errors} failure={failure} />;
  const ready = (n: StepNo) => stepReady(n, form, files);
  const nextLabel = (from: StepNo) =>
    stage === 4 && from < 3 && nextTarget(from) === 4 ? "Back to review" : "Next";
  const repo = repoConfirmation(form);
  const contenders = form.contenders;

  return (
    <form
      ref={formRef}
      className={styles.flow}
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      noValidate
      aria-busy={busy !== null}
      aria-label="New run"
    >
      <Progress stage={stage} open={open} />
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>

      {/* 1 · What did you build? */}
      <Step
        meta={STEPS[0]!}
        state={open === 1 ? "open" : "done"}
        summary={sourceSummary(form, files)}
        onEdit={() => openStep(1, "edit")}
      >
        {alerts}
        {form.sourceKind === "github" && (
          <>
            <div className={styles.field}>
              <label className={styles.lbl} htmlFor="nr-repo">
                GitHub repo URL
              </label>
              <input
                id="nr-repo"
                data-first-field
                className={`${styles.input} ${styles.big}`}
                placeholder="https://github.com/owner/repo"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
                aria-describedby="nr-repo-hint"
                value={form.repo}
                onChange={(e) => update("repo", e.target.value)}
              />
              <p id="nr-repo-hint" className={styles.hint} aria-live="polite">
                {repo ? (
                  <span className={styles.confirm}>
                    {repo.slug} · {repo.ref ?? "default branch"} ✓
                  </span>
                ) : form.repo.trim() ? (
                  "Not a GitHub repo yet. Paste owner/repo or a github.com URL."
                ) : (
                  "Paste the repo. A /tree/<branch> link picks the branch too."
                )}
              </p>
            </div>
            <Disclosure
              id="nr-advanced"
              label="Advanced"
              open={advancedOpen}
              onToggle={() => setAdvancedOpen((o) => !o)}
            >
              <OptionRow
                label="Branch, tag or commit"
                htmlFor="nr-ref"
                optional
                explain="Leave it empty to test the default branch."
              >
                <input
                  id="nr-ref"
                  className={styles.input}
                  placeholder={repo?.ref ?? "main"}
                  spellCheck={false}
                  autoCapitalize="off"
                  value={form.ref}
                  onChange={(e) => update("ref", e.target.value)}
                />
              </OptionRow>
            </Disclosure>
          </>
        )}
        {form.sourceKind === "binary" && (
          <>
            <div className={styles.row}>
              <Field label="Binary" htmlFor="nr-binary" chosen={files.binary}>
                <input
                  id="nr-binary"
                  data-first-field
                  type="file"
                  className={styles.input}
                  onChange={(e) => setFile("binary", e.target.files?.[0])}
                />
              </Field>
              <Field label="Or a download URL" htmlFor="nr-binary-url">
                <input
                  id="nr-binary-url"
                  type="url"
                  className={styles.input}
                  placeholder="https://…"
                  value={form.binaryUrl}
                  onChange={(e) => update("binaryUrl", e.target.value)}
                />
              </Field>
            </div>
            <div className={styles.row}>
              <Field
                label="Docs"
                htmlFor="nr-docs"
                optional
                hint="README, man page or a docs bundle."
                chosen={files.docs}
              >
                <input
                  id="nr-docs"
                  type="file"
                  className={styles.input}
                  onChange={(e) => setFile("docs", e.target.files?.[0])}
                />
              </Field>
              <Field label="Or a docs URL" htmlFor="nr-docs-url" optional>
                <input
                  id="nr-docs-url"
                  type="url"
                  className={styles.input}
                  placeholder="https://…"
                  value={form.docsUrl}
                  onChange={(e) => update("docsUrl", e.target.value)}
                />
              </Field>
            </div>
          </>
        )}
        {form.sourceKind === "claude_setup" && (
          <Field
            label="Your .claude/ setup"
            htmlFor="nr-setup"
            hint="Zip .claude/, CLAUDE.md and .mcp.json together. Secrets stay out: add keys in Settings."
            chosen={files.claudeSetup}
          >
            <input
              id="nr-setup"
              data-first-field
              type="file"
              accept=".zip,.tar,.tgz,.tar.gz,application/zip,application/gzip"
              className={styles.input}
              onChange={(e) => setFile("claudeSetup", e.target.files?.[0])}
            />
          </Field>
        )}
        <p className={styles.alt}>
          {form.sourceKind === "github"
            ? "Uploading a binary or a Claude Code setup instead? "
            : "Or instead: "}
          {(Object.keys(SOURCE_LABEL) as SourceKind[])
            .filter((k) => k !== form.sourceKind)
            .map((k, i) => (
              <span key={k}>
                {i > 0 && " · "}
                <button type="button" className={styles.linkBtn} onClick={() => chooseSource(k)}>
                  {SOURCE_LABEL[k]}
                </button>
              </span>
            ))}
        </p>
        <StepActions show={ready(1)} label={nextLabel(1)} onNext={() => advance(1)} />
      </Step>

      {/* 2 · What do you want to find out? */}
      {stage >= 2 && (
        <Step
          meta={STEPS[1]!}
          state={open === 2 ? "open" : "done"}
          summary={form.question.trim() || "No question yet"}
          onEdit={() => openStep(2, "edit")}
        >
          {alerts}
          {active?.status === "loading" && (
            <p className={styles.reading} role="status">
              <span className={styles.liveDot} aria-hidden="true" />
              <span>
                <b>Reading your repo…</b> Anybench is looking at the README and file tree to suggest
                a question.
              </span>
            </p>
          )}
          {suggestion && (
            <p className={styles.read}>
              <span className={styles.badge}>Suggested by Anybench</span>
              <span>{suggestion.project_summary}</span>
            </p>
          )}
          <div className={styles.field}>
            <textarea
              id="nr-question"
              aria-labelledby="nr-step-2-title"
              aria-describedby="nr-question-hint"
              className={styles.textarea}
              placeholder="Is it faster than ripgrep? Does it beat plain Claude Code?"
              value={form.question}
              onChange={(e) => {
                setQuestionSuggested(false);
                update("question", e.target.value);
              }}
            />
            <p id="nr-question-hint" className={styles.hint}>
              {questionSuggested && suggestion
                ? "Suggested by Anybench from your README. Edit it, or pick another below."
                : "One sentence is enough; agents work out the rest."}
            </p>
          </div>
          {suggestion ? (
            <Chips
              label="Other questions Anybench suggests"
              items={suggestion.questions.filter((q) => q !== form.question)}
              onPick={(q) => {
                update("question", q);
                setQuestionSuggested(true);
              }}
            />
          ) : (
            active?.status !== "loading" && (
              <Chips
                label="Examples"
                items={EXAMPLE_QUESTIONS}
                onPick={(q) => {
                  update("question", q);
                  setQuestionSuggested(false);
                  formRef.current?.querySelector<HTMLElement>("#nr-question")?.focus();
                }}
              />
            )
          )}
          <StepActions show={ready(2)} label={nextLabel(2)} onNext={() => advance(2)} kbd />
        </Step>
      )}

      {/* 3 · What should it be compared against? */}
      {stage >= 3 && (
        <Step
          meta={STEPS[2]!}
          state={open === 3 ? "open" : "done"}
          summary={compareSummary(names)}
          onEdit={() => openStep(3, "edit")}
        >
          {alerts}
          {keptNow.length > 0 ? (
            <div className={styles.field}>
              <p className={styles.read}>
                <span className={styles.badge}>Suggested by Anybench</span>
                <span>Remove any you don&rsquo;t want.</span>
              </p>
              <ul className={styles.altList} aria-label="Suggested alternatives">
                {keptNow.map((a) => (
                  <li key={a.name} className={styles.altItem}>
                    <div className={styles.setupBody}>
                      <b>{a.name}</b>
                      <small>{a.reason}</small>
                    </div>
                    <button
                      type="button"
                      className={styles.remove}
                      aria-label={`Remove ${a.name}`}
                      onClick={() => {
                        idempotencyKey.current = null;
                        setKept((k) => k.filter((x) => x.name !== a.name));
                      }}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <p className={styles.hint}>
                Anybench also adds any other obvious alternative it finds when it designs the test.
              </p>
            </div>
          ) : (
            <div className={styles.setup}>
              <span className={styles.tick} aria-hidden="true">
                ✓
              </span>
              <div className={styles.setupBody}>
                <b>Let Anybench pick the obvious alternatives</b>
                <small>Recommended. Agents look for them when they design the test.</small>
              </div>
            </div>
          )}
          {suggestion && kept.length < suggestion.alternatives.length && (
            <button
              type="button"
              className={`${styles.linkBtn} ${styles.add}`}
              onClick={() => setKept(suggestion.alternatives)}
            >
              Restore Anybench&rsquo;s suggestions
            </button>
          )}
          {contenders.map((c, i) => (
            <div key={i} className={styles.setup}>
              <span className={styles.sl}>{String(i + 1).padStart(2, "0")}</span>
              <div className={styles.setupBody}>
                <input
                  className={styles.input}
                  aria-label={`Other setup ${i + 1}`}
                  placeholder="A name or a GitHub URL, e.g. ripgrep"
                  value={c}
                  onChange={(e) =>
                    update(
                      "contenders",
                      contenders.map((x, j) => (j === i ? e.target.value : x)),
                    )
                  }
                />
              </div>
              <button
                type="button"
                className={styles.remove}
                aria-label={`Remove setup ${i + 1}`}
                onClick={() =>
                  update(
                    "contenders",
                    contenders.filter((_, j) => j !== i),
                  )
                }
              >
                ✕
              </button>
            </div>
          ))}
          {contenders.length < 10 && (
            <button
              type="button"
              className={`btn btn-quiet ${styles.add}`}
              onClick={() => update("contenders", [...contenders, ""])}
            >
              + Add a setup
            </button>
          )}
          <StepActions show label={nextLabel(3)} onNext={() => advance(3)} kbd />
        </Step>
      )}

      {/* 4 · Review and start */}
      {stage >= 4 && (
        <Step
          meta={STEPS[3]!}
          state={open === 4 ? "open" : "done"}
          summary={optionsSummary(form)}
          onEdit={() => openStep(4, "edit")}
        >
          <p className={styles.hint}>
            The lines above are what Anybench will test. Agents read what you built, pick tasks and
            a correctness gate, and draft the test plan for you to check.
          </p>
          <Disclosure
            id="nr-options"
            label="Options (defaults are fine)"
            open={optionsOpen}
            onToggle={() => setOptionsOpen((o) => !o)}
            closedNote={`${optionsSuggested ? "Suggested by Anybench: " : ""}${optionsSummary(form)}`}
          >
            <OptionRow
              label="Runs per setup"
              htmlFor="nr-runs"
              optional
              explain={`How many times each setup runs each task (${RUNS_PER_SETUP_MIN}–${RUNS_PER_SETUP_MAX}). More runs, tighter error bars.`}
            >
              <input
                id="nr-runs"
                type="number"
                inputMode="numeric"
                min={RUNS_PER_SETUP_MIN}
                max={RUNS_PER_SETUP_MAX}
                className={styles.input}
                value={Number.isNaN(form.runsPerSetup) ? "" : form.runsPerSetup}
                onChange={(e) => {
                  latest.current.runs = true;
                  update("runsPerSetup", e.target.valueAsNumber);
                }}
              />
            </OptionRow>
            <OptionRow
              label="Approvals"
              htmlFor="nr-approvals"
              optional
              explain="Who answers when the agent under test asks for permission."
            >
              <select
                id="nr-approvals"
                className={styles.select}
                value={form.approvals}
                onChange={(e) => {
                  latest.current.approvals = true;
                  update("approvals", e.target.value as ApprovalsPolicy);
                }}
              >
                {(Object.keys(APPROVALS_LABEL) as ApprovalsPolicy[]).map((k) => (
                  <option key={k} value={k}>
                    {APPROVALS_LABEL[k]}
                  </option>
                ))}
              </select>
            </OptionRow>
            <OptionRow
              label="Budget cap (USD)"
              htmlFor="nr-budget"
              optional
              explain="The run pauses if it reaches this. You see the estimate before Go."
            >
              <input
                id="nr-budget"
                inputMode="decimal"
                className={styles.input}
                value={form.budgetUsd}
                onChange={(e) => update("budgetUsd", e.target.value)}
              />
            </OptionRow>
            <fieldset className={styles.option}>
              <legend className={styles.optionHead}>
                <span className={styles.lbl}>Send results to</span>
                <span className={styles.tag}>Optional</span>
              </legend>
              <div className={styles.checks}>
                <label className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={form.notifyEmail}
                    onChange={(e) => update("notifyEmail", e.target.checked)}
                  />
                  Email
                </label>
                <label className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={form.notifySlack}
                    onChange={(e) => update("notifySlack", e.target.checked)}
                  />
                  Slack
                </label>
              </div>
              <p className={styles.hint}>Where the report goes when it&rsquo;s done.</p>
            </fieldset>
            <div className={styles.option}>
              <div className={styles.optionHead}>
                <span className={styles.lbl}>Plan review</span>
                <span className={styles.tag}>Optional</span>
              </div>
              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={form.reviewFirst}
                  onChange={(e) => update("reviewFirst", e.target.checked)}
                />
                Let me review the test plan before it starts
              </label>
              <p className={styles.hint}>
                Off: the run starts as soon as the plan and the estimate are ready.
              </p>
            </div>
          </Disclosure>
          {alerts}
          <div className={styles.actions}>
            <button type="submit" className="btn" disabled={busy !== null}>
              {busy ? "Working…" : "Design the test"}
            </button>
          </div>
          <p className={styles.status} role="status">
            {busy ?? "Free to create. Nothing is billed until you press Go."}
          </p>
        </Step>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Pieces

function Progress({ stage, open }: { stage: StepNo; open: StepNo }) {
  return (
    <ol className={styles.progress} aria-label="Steps">
      {STEPS.map((s) => {
        const state = s.no === open ? "current" : s.no <= stage ? "done" : "todo";
        return (
          <li
            key={s.no}
            className={styles.progressItem}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className={styles.progressNo}>{s.no}</span>
            <span className={styles.progressLabel}>
              {s.short}
              {!s.required && s.no !== 4 && <span className="visually-hidden"> (optional)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Step({
  meta,
  state,
  summary,
  onEdit,
  children,
}: {
  meta: StepMeta;
  state: "open" | "done";
  summary: string;
  onEdit: () => void;
  children: ReactNode;
}) {
  const titleId = `nr-step-${meta.no}-title`;
  const no = String(meta.no).padStart(2, "0");
  if (state === "done") {
    return (
      <section className={styles.stepDone} aria-labelledby={titleId}>
        <span className={styles.stepNo}>{no}</span>
        <h2 id={titleId} className={styles.doneTitle} tabIndex={-1}>
          {meta.short}
        </h2>
        <p className={styles.doneSummary} title={summary}>
          {summary}
        </p>
        <button
          type="button"
          className={styles.linkBtn}
          aria-label={`Edit ${meta.short.toLowerCase()}`}
          onClick={onEdit}
        >
          Edit
        </button>
      </section>
    );
  }
  const tag = meta.no === 4 ? null : meta.required ? "Required" : "Optional";
  return (
    <section className={styles.step} aria-labelledby={titleId}>
      <header className={styles.stepHead}>
        <span className={styles.stepNo}>{no}</span>
        <h2 id={titleId} className={styles.stepTitle} tabIndex={-1}>
          {meta.title}
        </h2>
        {tag && <span className={styles.tag}>{tag}</span>}
      </header>
      <div className={styles.stepBody}>{children}</div>
    </section>
  );
}

function StepActions({
  show,
  label,
  onNext,
  kbd,
}: {
  show: boolean;
  label: string;
  onNext: () => void;
  kbd?: boolean;
}) {
  if (!show) return null;
  return (
    <div className={styles.actions}>
      <button type="button" className="btn" onClick={onNext}>
        {label}
      </button>
      {kbd && (
        <span className={styles.kbd} aria-hidden="true">
          ⌘/Ctrl + Enter
        </span>
      )}
    </div>
  );
}

function Chips({
  label,
  items,
  onPick,
}: {
  label: string;
  items: readonly string[];
  onPick: (q: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className={styles.field}>
      <p className={styles.lbl}>{label}</p>
      <ul className={styles.chips} aria-label={label}>
        {items.map((q) => (
          <li key={q}>
            <button type="button" className={styles.chip} onClick={() => onPick(q)}>
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Disclosure({
  id,
  label,
  open,
  onToggle,
  closedNote,
  children,
}: {
  id: string;
  label: string;
  open: boolean;
  onToggle: () => void;
  closedNote?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.disclosure}>
      <button
        type="button"
        className={styles.disclosureBtn}
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className={styles.caret} aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        {label}
      </button>
      {!open && closedNote && <p className={styles.hint}>{closedNote}</p>}
      {open && (
        <div id={id} className={styles.disclosureBody}>
          {children}
        </div>
      )}
    </div>
  );
}

function OptionRow({
  label,
  htmlFor,
  explain,
  optional,
  children,
}: {
  label: string;
  htmlFor: string;
  explain: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.option}>
      <div className={styles.optionHead}>
        <label className={styles.lbl} htmlFor={htmlFor}>
          {label}
        </label>
        {optional && <span className={styles.tag}>Optional</span>}
      </div>
      {children}
      <p className={styles.hint}>{explain}</p>
    </div>
  );
}

function Alerts({ errors, failure }: { errors: string[]; failure: SubmitFailure | null }) {
  return (
    <>
      {errors.length > 0 && (
        <div className={styles.errors} role="alert">
          Fix these first:
          <ul>
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {failure?.kind === "payment" && (
        <div className={styles.notice} role="alert">
          Add a card or credit to start this run.{" "}
          {safeHttpsUrl(failure.linkCardUrl) ? (
            <a href={safeHttpsUrl(failure.linkCardUrl) ?? undefined}>Add a card</a>
          ) : (
            <a href="/billing">Go to billing</a>
          )}
        </div>
      )}
      {failure?.kind === "message" && (
        <div className={styles.errors} role="alert">
          {failure.message}
          {failure.issues.length > 0 && (
            <ul>
              {failure.issues.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

type FileKey = "binary" | "docs" | "claudeSetup";
const FILE_PURPOSE: Readonly<Record<FileKey, "binary" | "docs" | "claude_setup">> = {
  binary: "binary",
  docs: "docs",
  claudeSetup: "claude_setup",
};

/** The files the chosen source will upload. */
function chosenFiles(kind: SourceKind, files: ChosenFiles): [FileKey, File][] {
  const keys: FileKey[] =
    kind === "binary" ? ["binary", "docs"] : kind === "claude_setup" ? ["claudeSetup"] : [];
  return keys.flatMap((k) => {
    const f = files[k];
    return f ? [[k, f] as [FileKey, File]] : [];
  });
}

/** For the pre-upload check: a chosen file counts as an upload that will exist. */
function placeholderUploads(kind: SourceKind, files: ChosenFiles): UploadedIds {
  const pending = "00000000-0000-4000-8000-000000000000";
  if (kind === "binary")
    return {
      ...(files.binary ? { binary: pending } : {}),
      ...(files.docs ? { docs: pending } : {}),
    };
  if (kind === "claude_setup") return files.claudeSetup ? { claudeSetup: pending } : {};
  return {};
}

function Field({
  label,
  htmlFor,
  hint,
  optional,
  chosen,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  optional?: boolean;
  chosen?: File | undefined;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <div className={styles.optionHead}>
        <label className={styles.lbl} htmlFor={htmlFor}>
          {label}
        </label>
        {optional && <span className={styles.tag}>Optional</span>}
      </div>
      {children}
      {chosen && (
        <p className={styles.hint}>
          Chosen: {chosen.name} ({formatBytes(chosen.size)})
        </p>
      )}
      {hint && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}
