// A scripted fetch: each call shifts the next canned response and records the request.
export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function scriptedFetch(responses: { status: number; body: unknown }[]) {
  const calls: Recorded[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", "x-request-id": "req-test" },
    });
  };
  return { fetchFn, calls };
}
