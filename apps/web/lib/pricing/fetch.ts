// TDM-226: the pricing page's two public reads, on the server: GET /billing/pricing (every number
// on the page, from the API's billing config) and GET /billing/free-pool (open or paused). No
// credentials. Cached for 60 s, like the API's own Cache-Control. A read that fails gives null and
// the page says so; it never falls back to numbers typed into the web app.
import {
  PublicFreePoolSchema,
  PublicPricingSchema,
  type PublicFreePool,
  type PublicPricing,
} from "@anybench/core";
import type { z } from "zod";
import { upstreamApiUrl } from "../api-upstream";

export const PRICING_REVALIDATE_SECONDS = 60;

export interface PublicReadOptions {
  fetcher?: typeof fetch;
  base?: string;
}

async function read<S extends z.ZodType>(
  path: string,
  schema: S,
  opts: PublicReadOptions,
): Promise<z.output<S> | null> {
  const base = opts.base ?? upstreamApiUrl();
  const f = opts.fetcher ?? fetch;
  try {
    const res = await f(`${base}${path}`, {
      headers: { accept: "application/json" },
      next: { revalidate: PRICING_REVALIDATE_SECONDS },
    } as RequestInit);
    if (!res.ok) return null;
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function fetchPublicPricing(opts: PublicReadOptions = {}): Promise<PublicPricing | null> {
  return read("/billing/pricing", PublicPricingSchema, opts);
}

export function fetchFreePool(opts: PublicReadOptions = {}): Promise<PublicFreePool | null> {
  return read("/billing/free-pool", PublicFreePoolSchema, opts);
}
