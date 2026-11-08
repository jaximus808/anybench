"use client";
// API keys (TDM-100): list, create (the secret is shown once, with a copy button), revoke.
import { API_KEY_SCOPES, type ApiKey, type ApiKeyScope } from "@anybench/core";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import styles from "./settings.module.css";

/** What a new key can do by default: run benchmarks from the CLI and read the results. */
export const DEFAULT_KEY_SCOPES: readonly ApiKeyScope[] = [
  "runs:read",
  "runs:write",
  "events:read",
  "logs:read",
];

/** `admin` is never offered here; the API enforces who may hold it. */
const OFFERED_SCOPES = API_KEY_SCOPES.filter((s) => s !== "admin");

function formatDate(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>([...DEFAULT_KEY_SCOPES]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { items } = await api().apiKeys.list();
      setKeys(items);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api().apiKeys.create({ body: { name: name.trim(), scopes, mode: "live" } });
      setCreated({ name: res.api_key.name, secret: res.secret });
      setCopied(false);
      setName("");
      setKeys((prev) => [res.api_key, ...(prev ?? [])]);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(key: ApiKey) {
    if (!window.confirm(`Revoke "${key.name}"? Anything using it stops working.`)) return;
    setError(null);
    try {
      const { api_key } = await api().apiKeys.revoke({ params: { id: key.id } });
      setKeys((prev) => (prev ?? []).map((k) => (k.id === api_key.id ? api_key : k)));
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }

  async function onCopy(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Select the key and copy it by hand.");
    }
  }

  return (
    <section className={styles.card} aria-labelledby="api-keys-title">
      <h2 id="api-keys-title">API keys</h2>
      <p className="muted">
        For the <code>anybench</code> CLI, the MCP server and your own agents. A key is shown once,
        when you create it.
      </p>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {created ? (
        <div className={styles.secret} role="status">
          <p>
            <strong>{created.name}</strong> is ready. Copy it now; you won&rsquo;t see it again.
          </p>
          <div className={styles.secretRow}>
            <code aria-label="New API key">{created.secret}</code>
            <button type="button" className="btn" onClick={() => void onCopy(created.secret)}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button type="button" className={styles.linkButton} onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      ) : null}

      <form className={styles.form} onSubmit={onCreate} aria-label="Create an API key">
        <label className={styles.field}>
          <span>Name</span>
          <input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. laptop CLI"
            maxLength={100}
            required
          />
        </label>
        <fieldset className={styles.scopes}>
          <legend>Scopes</legend>
          {OFFERED_SCOPES.map((s) => (
            <label key={s}>
              <input
                type="checkbox"
                checked={scopes.includes(s)}
                onChange={(e) =>
                  setScopes((prev) =>
                    e.target.checked ? [...prev, s] : prev.filter((x) => x !== s),
                  )
                }
              />{" "}
              <code>{s}</code>
            </label>
          ))}
        </fieldset>
        <button
          type="submit"
          className="btn"
          disabled={busy || !name.trim() || scopes.length === 0}
        >
          {busy ? "Creating…" : "Create key"}
        </button>
      </form>

      {keys === null && !error ? (
        <p className="muted" role="status">
          Loading keys…
        </p>
      ) : null}
      {keys && keys.length === 0 ? <p className="muted">No API keys yet.</p> : null}
      {keys && keys.length > 0 ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Key</th>
              <th scope="col">Scopes</th>
              <th scope="col">Last used</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} data-revoked={k.revoked_at ? "" : undefined}>
                <td>{k.name}</td>
                <td>
                  <code>{k.prefix}…</code>
                </td>
                <td>{k.scopes.join(", ")}</td>
                <td>{formatDate(k.last_used_at)}</td>
                <td>
                  {k.revoked_at ? (
                    <span className="muted">Revoked</span>
                  ) : (
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => void onRevoke(k)}
                      aria-label={`Revoke ${k.name}`}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
