// A routing fake fetch for TDM-163 tests: one handler per (method, host+path) match. Records every
// request; an unmatched URL throws, so a test can never reach the network.
import {
  HUNTER_FOUND,
  HUNTER_NOT_FOUND,
  READMES,
  REPOS,
  SEARCH_BODY,
  USAGE_BODY,
  USERS,
} from "./tdm163-fixtures.js";

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}
export type Handler = (
  url: URL,
  init: RequestInit | undefined,
  body: unknown,
) => Reply | Promise<Reply>;

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export function routerFetch(routes: [RegExp, Handler][]) {
  const calls: RecordedCall[] = [];
  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url: input, headers, body });
    const key = `${method} ${url.host}${url.pathname}`;
    for (const [re, h] of routes) {
      if (re.test(key)) {
        const r = await h(url, init, body);
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "content-type": "application/json", ...(r.headers ?? {}) },
        });
      }
    }
    throw new Error(`unexpected fetch ${key}`);
  };
  return { fetchFn, calls };
}

const lowerKey = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
const REPOS_L = lowerKey(REPOS);
const READMES_L = lowerKey(READMES);
const USERS_L = lowerKey(USERS);

/** Context.dev with the spike's search answer. */
export const contextDevRoutes = (): [RegExp, Handler][] => [
  [
    /^POST api\.context\.dev\/v1\/web\/search$/,
    () => ({
      status: 200,
      body: SEARCH_BODY,
      headers: { "x-credits-used": "1", "x-request-id": "8dc3c8ab-test" },
    }),
  ],
  [/^GET api\.context\.dev\/v1\/org\/usage$/, () => ({ status: 200, body: USAGE_BODY })],
];

/** GitHub REST with the fixture repos, READMEs and users. */
export const githubRoutes = (remaining = 50): [RegExp, Handler][] => {
  const rl = { "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": "1794110000" };
  return [
    [
      /^GET api\.github\.com\/repos\/[^/]+\/[^/]+\/readme$/,
      (u) => {
        const [, , owner, repo] = u.pathname.split("/");
        const b = READMES_L[`${owner}/${repo}`.toLowerCase()];
        return b ? { status: 200, body: b, headers: rl } : { status: 404, body: {}, headers: rl };
      },
    ],
    [
      /^GET api\.github\.com\/repos\/[^/]+\/[^/]+$/,
      (u) => {
        const [, , owner, repo] = u.pathname.split("/");
        const b = REPOS_L[`${owner}/${repo}`.toLowerCase()];
        return b ? { status: 200, body: b, headers: rl } : { status: 404, body: {}, headers: rl };
      },
    ],
    [
      /^GET api\.github\.com\/users\/[^/]+$/,
      (u) => {
        const login = u.pathname.split("/")[2] ?? "";
        const b = USERS_L[login.toLowerCase()];
        return b ? { status: 200, body: b, headers: rl } : { status: 404, body: {}, headers: rl };
      },
    ],
  ];
};

/** Monid /v1/run: Hunter finds an address only on samuelfaj.example. */
export const monidRoutes = (): [RegExp, Handler][] => [
  [
    /^POST api\.monid\.ai\/v1\/run$/,
    (_u, _i, body) => {
      const b = body as { provider: string; input: { queryParams?: { domain?: string } } };
      if (b.provider === "hunterio") {
        return {
          status: 200,
          body:
            b.input.queryParams?.domain === "samuelfaj.example" ? HUNTER_FOUND : HUNTER_NOT_FOUND,
        };
      }
      return { status: 400, body: { code: 400, message: `no fake for ${b.provider}` } };
    },
  ],
];
