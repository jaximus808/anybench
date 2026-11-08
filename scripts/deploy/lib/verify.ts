// Live checks after an API deploy (TDM-154). Each returns `{ ok, detail }` and never a secret:
// the GitHub client id is public (it is in every authorize URL), the callback is a plain URL.

export interface Check {
  name: string;
  ok: boolean;
  detail: Record<string, unknown>;
}

/** The OAuth start must 302 to GitHub's authorize URL with our client_id and callback. */
export function checkOAuthRedirect(
  status: number,
  location: string | null,
  expected: { clientId: string; callbackUrl: string },
): Check {
  let url: URL | undefined;
  try {
    url = location ? new URL(location) : undefined;
  } catch {
    url = undefined;
  }
  const clientId = url?.searchParams.get("client_id") ?? null;
  const redirectUri = url?.searchParams.get("redirect_uri") ?? null;
  const ok =
    status === 302 &&
    url?.origin === "https://github.com" &&
    url.pathname === "/login/oauth/authorize" &&
    clientId === expected.clientId &&
    redirectUri === expected.callbackUrl &&
    Boolean(url.searchParams.get("state"));
  return {
    name: "oauth start",
    ok,
    detail: {
      status,
      location: url ? `${url.origin}${url.pathname}` : location,
      client_id: clientId,
      redirect_uri: redirectUri,
      state: url?.searchParams.get("state") ? "present" : "missing",
      scope: url?.searchParams.get("scope") ?? null,
    },
  };
}

/** /health must be 200 with a working database ping. */
export function checkHealth(status: number, body: unknown): Check {
  const b = (body ?? {}) as {
    ok?: unknown;
    env?: unknown;
    db?: { ok?: unknown; latencyMs?: unknown };
  };
  return {
    name: "health",
    ok: status === 200 && b.ok === true && b.db?.ok === true,
    detail: { status, ok: b.ok, env: b.env, db: b.db },
  };
}

/** A credentialed preflight from the web origin must be allowed, exactly that origin. */
export function checkPreflight(status: number, headers: Headers, origin: string): Check {
  const acao = headers.get("access-control-allow-origin");
  const acac = headers.get("access-control-allow-credentials");
  return {
    name: "cors preflight",
    ok: status === 204 && acao === origin && acac === "true",
    detail: {
      status,
      "access-control-allow-origin": acao,
      "access-control-allow-credentials": acac,
    },
  };
}
