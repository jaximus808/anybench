"use client";
// BYOK model keys (TDM-100): write-only. The API never returns a value, only its last 4 characters.
import type { SecretSummary } from "@anybench/core";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import styles from "./settings.module.css";

export const MODEL_PROVIDERS = [
  { id: "anthropic", label: "Anthropic", placeholder: "sk-ant-…" },
  { id: "openai", label: "OpenAI", placeholder: "sk-…" },
] as const;

/** `onChange`: a key was saved or removed (onboarding re-reads whether the free run can be used). */
export function ModelKeysSection({ onChange }: { onChange?: () => void } = {}) {
  const [secrets, setSecrets] = useState<SecretSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { items } = await api().secrets.list();
      setSecrets(items);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upsert = (s: SecretSummary) => {
    setSecrets((prev) => [...(prev ?? []).filter((x) => x.provider !== s.provider), s]);
    onChange?.();
  };
  const remove = (provider: string) => {
    setSecrets((prev) => (prev ?? []).filter((x) => x.provider !== provider));
    onChange?.();
  };

  return (
    <section className={styles.card} aria-labelledby="model-keys-title">
      <h2 id="model-keys-title">Model keys</h2>
      <p className="muted">
        Bring your own Anthropic or OpenAI key for the agent under test. Keys are encrypted at rest,
        used only inside your trials, and can&rsquo;t be read back.
      </p>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {secrets === null && !error ? (
        <p className="muted" role="status">
          Loading model keys…
        </p>
      ) : null}
      {secrets !== null
        ? MODEL_PROVIDERS.map((p) => (
            <ProviderKey
              key={p.id}
              provider={p}
              summary={secrets.find((s) => s.provider === p.id)}
              onSaved={upsert}
              onRemoved={remove}
            />
          ))
        : null}
    </section>
  );
}

function ProviderKey({
  provider,
  summary,
  onSaved,
  onRemoved,
}: {
  provider: (typeof MODEL_PROVIDERS)[number];
  summary: SecretSummary | undefined;
  onSaved: (s: SecretSummary) => void;
  onRemoved: (provider: string) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `model-key-${provider.id}`;

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { secret } = await api().secrets.put({
        params: { provider: provider.id },
        body: { value: value.trim() },
      });
      setValue("");
      onSaved(secret);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    if (!window.confirm(`Remove your ${provider.label} key?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api().secrets.delete({ params: { provider: provider.id } });
      onRemoved(provider.id);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.provider} onSubmit={onSave} aria-label={`${provider.label} key`}>
      <div className={styles.providerHead}>
        <label htmlFor={inputId}>
          <strong>{provider.label}</strong>
        </label>
        <span className="muted" data-testid={`${provider.id}-status`}>
          {summary ? (
            <>
              On file, ending <code>{summary.last4}</code>
            </>
          ) : (
            "Not set"
          )}
        </span>
      </div>
      <div className={styles.secretRow}>
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={summary ? "Paste a new key to replace it" : provider.placeholder}
          minLength={8}
          maxLength={4096}
        />
        <button type="submit" className="btn" disabled={busy || value.trim().length < 8}>
          {summary ? "Replace" : "Save"}
        </button>
        {summary ? (
          <button
            type="button"
            className="btn btn-quiet"
            disabled={busy}
            onClick={() => void onRemove()}
          >
            Remove
          </button>
        ) : null}
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
