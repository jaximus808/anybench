// Publications (E12): read a public publication from the API (GET /public/r/:slug) on the server.
// No credentials, no cache: a republish must show at once.
import {
  PublicPublicationSchema,
  PublicationSlugSchema,
  type PublicPublication,
} from "@anybench/core";
import { upstreamApiUrl } from "../api-upstream";

export type PublicationFetch =
  | { kind: "found"; data: PublicPublication }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export async function fetchPublication(
  slug: string,
  opts: { version?: number; fetcher?: typeof fetch; base?: string } = {},
): Promise<PublicationFetch> {
  if (!PublicationSlugSchema.safeParse(slug).success) return { kind: "missing" };
  const base = opts.base ?? upstreamApiUrl();
  const q = opts.version ? `?version=${opts.version}` : "";
  const f = opts.fetcher ?? fetch;
  try {
    const res = await f(`${base}/public/r/${slug}${q}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    } as RequestInit);
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) return { kind: "error", message: `the API answered ${res.status}` };
    const parsed = PublicPublicationSchema.safeParse(await res.json());
    if (!parsed.success)
      return { kind: "error", message: "the API returned an unreadable publication" };
    return { kind: "found", data: parsed.data };
  } catch {
    return { kind: "error", message: "the API could not be reached" };
  }
}
