"use client";
// The Ask screen (TDM-101): what to benchmark, the question, other setups, and the run's
// preferences. Submits runs.create with an Idempotency-Key and opens /runs/[id]. Creating a run
// is free; the estimate shows on the run page and Go is where the billing gate applies.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ApiClient } from "@anybench/core";
import { api } from "../../../lib/api";
import {
  APPROVALS_LABEL,
  buildCreateRunBody,
  describeError,
  EMPTY_FORM,
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

const SOURCES: readonly { kind: SourceKind; label: string }[] = [
  { kind: "github", label: "GitHub repo" },
  { kind: "binary", label: "Binary + docs" },
  { kind: "claude_setup", label: "Claude Code setup" },
];

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
  const [files, setFiles] = useState<{ binary?: File; docs?: File; claudeSetup?: File }>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // One key per attempt: a retry of the same form reuses it, any edit starts a new one.
  const idempotencyKey = useRef<string | null>(null);
  // Uploads already finished for this exact file, so a retry doesn't upload twice.
  const uploaded = useRef(new Map<File, string>());

  useEffect(() => {
    let live = true;
    client.auth.me().catch((err: unknown) => {
      if (live && describeError(err).kind === "signed_out") router.replace(SIGNIN_NEW_RUN);
    });
    return () => {
      live = false;
    };
  }, [client, router]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    idempotencyKey.current = null;
    setForm((f) => ({ ...f, [key]: value }));
  }
  function setFile(key: keyof typeof files, file: File | undefined) {
    idempotencyKey.current = null;
    setFiles((f) => ({ ...f, [key]: file }));
    // Checked from file.size alone, before any byte is read.
    const tooBig = file ? uploadSizeError(file.size, FILE_PURPOSE[key]) : null;
    setErrors(tooBig ? [tooBig] : []);
  }

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
    if (busy) return;
    setFailure(null);
    const precheck = buildCreateRunBody(form, placeholderUploads(form.sourceKind, files));
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
      const built = buildCreateRunBody(form, ids);
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

  const contenders = form.contenders;
  return (
    <form className={styles.card} onSubmit={onSubmit} noValidate aria-busy={busy !== null}>
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
      <div className={styles.formGrid}>
        <div className={styles.stack}>
          <fieldset className={styles.field}>
            <legend className={styles.lbl}>What to benchmark</legend>
            <div className={styles.tabs}>
              {SOURCES.map((s) => (
                <button
                  key={s.kind}
                  type="button"
                  className={styles.tab}
                  aria-pressed={form.sourceKind === s.kind}
                  onClick={() => update("sourceKind", s.kind)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {form.sourceKind === "github" && (
              <div className={styles.row}>
                <Field label="Repo URL" htmlFor="nr-repo">
                  <input
                    id="nr-repo"
                    className={styles.input}
                    placeholder="https://github.com/owner/repo"
                    autoComplete="off"
                    spellCheck={false}
                    value={form.repo}
                    onChange={(e) => update("repo", e.target.value)}
                  />
                </Field>
                <Field
                  label="Branch, tag or commit"
                  htmlFor="nr-ref"
                  hint="Optional. Default branch."
                >
                  <input
                    id="nr-ref"
                    className={styles.input}
                    placeholder="main"
                    spellCheck={false}
                    value={form.ref}
                    onChange={(e) => update("ref", e.target.value)}
                  />
                </Field>
              </div>
            )}
            {form.sourceKind === "binary" && (
              <>
                <div className={styles.row}>
                  <Field label="Binary" htmlFor="nr-binary">
                    <input
                      id="nr-binary"
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
                  <Field label="Docs" htmlFor="nr-docs" hint="README, man page or a docs bundle.">
                    <input
                      id="nr-docs"
                      type="file"
                      className={styles.input}
                      onChange={(e) => setFile("docs", e.target.files?.[0])}
                    />
                  </Field>
                  <Field label="Or a docs URL" htmlFor="nr-docs-url">
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
              >
                <input
                  id="nr-setup"
                  type="file"
                  accept=".zip,.tar,.tgz,.tar.gz,application/zip,application/gzip"
                  className={styles.input}
                  onChange={(e) => setFile("claudeSetup", e.target.files?.[0])}
                />
              </Field>
            )}
          </fieldset>

          <Field label="Your question" htmlFor="nr-question">
            <textarea
              id="nr-question"
              className={styles.textarea}
              placeholder="Is it faster than ripgrep? Does it beat plain Claude Code?"
              value={form.question}
              onChange={(e) => update("question", e.target.value)}
            />
          </Field>

          <fieldset className={styles.field}>
            <legend className={styles.lbl}>Setups to compare</legend>
            <div className={styles.setup}>
              <span className={styles.sl}>01</span>
              <div className={styles.setupBody}>
                <b>Yours</b>
                <small>Anybench also looks for the obvious alternatives.</small>
              </div>
            </div>
            {contenders.map((c, i) => (
              <div key={i} className={styles.setup}>
                <span className={styles.sl}>{String(i + 2).padStart(2, "0")}</span>
                <div className={styles.setupBody}>
                  <input
                    className={styles.input}
                    aria-label={`Setup ${i + 2}`}
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
                  aria-label={`Remove setup ${i + 2}`}
                  onClick={() =>
                    update(
                      "contenders",
                      contenders.filter((_, j) => j !== i),
                    )
                  }
                >
                  remove
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
          </fieldset>
        </div>

        <div className={styles.stack}>
          <div className={styles.kv}>
            <span className={styles.lbl}>Tasks</span>
            <span>
              Let Anybench choose <em>(recommended)</em>
            </span>
          </div>
          <Field label="Runs per setup and task" htmlFor="nr-runs" kv>
            <input
              id="nr-runs"
              type="number"
              inputMode="numeric"
              min={RUNS_PER_SETUP_MIN}
              max={RUNS_PER_SETUP_MAX}
              className={styles.input}
              value={Number.isNaN(form.runsPerSetup) ? "" : form.runsPerSetup}
              onChange={(e) => update("runsPerSetup", e.target.valueAsNumber)}
            />
          </Field>
          <Field label="Approvals" htmlFor="nr-approvals" kv>
            <select
              id="nr-approvals"
              className={styles.select}
              value={form.approvals}
              onChange={(e) => update("approvals", e.target.value as ApprovalsPolicy)}
            >
              {(Object.keys(APPROVALS_LABEL) as ApprovalsPolicy[]).map((k) => (
                <option key={k} value={k}>
                  {APPROVALS_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Budget cap (USD)"
            htmlFor="nr-budget"
            hint="The run pauses if it reaches this. You see the estimate before Go."
            kv
          >
            <input
              id="nr-budget"
              inputMode="decimal"
              className={styles.input}
              value={form.budgetUsd}
              onChange={(e) => update("budgetUsd", e.target.value)}
            />
          </Field>
          <fieldset className={styles.kv}>
            <legend className={styles.lbl}>Send results to</legend>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={form.notifyEmail}
                onChange={(e) => update("notifyEmail", e.target.checked)}
              />
              Email
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={form.notifySlack}
                onChange={(e) => update("notifySlack", e.target.checked)}
              />
              Slack
            </label>
          </fieldset>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={form.reviewFirst}
              onChange={(e) => update("reviewFirst", e.target.checked)}
            />
            Let me review the test plan before it starts
          </label>
          <button type="submit" className="btn" disabled={busy !== null}>
            {busy ? "Working…" : "Design the test"}
          </button>
          <p className={styles.status} role="status">
            {busy ?? "Free to create. Nothing is billed until you press Go."}
          </p>
        </div>
      </div>
    </form>
  );
}

type FileKey = "binary" | "docs" | "claudeSetup";
const FILE_PURPOSE: Readonly<Record<FileKey, "binary" | "docs" | "claude_setup">> = {
  binary: "binary",
  docs: "docs",
  claudeSetup: "claude_setup",
};

/** The files the chosen source will upload. */
function chosenFiles(kind: SourceKind, files: Partial<Record<FileKey, File>>): [FileKey, File][] {
  const keys: FileKey[] =
    kind === "binary" ? ["binary", "docs"] : kind === "claude_setup" ? ["claudeSetup"] : [];
  return keys.flatMap((k) => {
    const f = files[k];
    return f ? [[k, f] as [FileKey, File]] : [];
  });
}

/** For the pre-upload check: a chosen file counts as an upload that will exist. */
function placeholderUploads(
  kind: SourceKind,
  files: { binary?: File; docs?: File; claudeSetup?: File },
): UploadedIds {
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
  kv,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  kv?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={kv ? styles.kv : styles.field}>
      <label className={styles.lbl} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}
