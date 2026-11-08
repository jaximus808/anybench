// TDM-88: a tiny in-memory Stripe API for the catalog endpoints, so the real SDK (pinned version,
// form encoding, auto-pagination, error mapping) is exercised without network or a key.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeCall {
  method: string;
  path: string;
  stripeVersion: string | undefined;
  authorization: string | undefined;
}

export interface FakeStripeTdm88 {
  port: number;
  calls: FakeCall[];
  meters: Record<string, unknown>[];
  products: Map<string, Record<string, unknown>>;
  prices: Record<string, unknown>[];
  /** What `livemode` the fake stamps on objects it creates. */
  livemode: boolean;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "request-id": "req_fake" });
  res.end(JSON.stringify(body));
}

function missing(res: ServerResponse, what: string): void {
  send(res, 404, {
    error: {
      type: "invalid_request_error",
      code: "resource_missing",
      message: `No such ${what}`,
    },
  });
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  return new URLSearchParams(raw);
}

export async function startFakeStripeTdm88(): Promise<FakeStripeTdm88> {
  let seq = 0;
  const state: Omit<FakeStripeTdm88, "port" | "close"> = {
    calls: [],
    meters: [],
    products: new Map(),
    prices: [],
    livemode: false,
  };
  const list = (data: unknown[], url: string) => ({ object: "list", data, has_more: false, url });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const path = url.pathname;
      const method = req.method ?? "GET";
      state.calls.push({
        method,
        path,
        stripeVersion: req.headers["stripe-version"] as string | undefined,
        authorization: req.headers.authorization,
      });
      const form = method === "POST" ? await readForm(req) : new URLSearchParams();

      if (path === "/v1/billing/meters" && method === "GET") {
        return send(res, 200, list(state.meters, path));
      }
      if (path === "/v1/billing/meters" && method === "POST") {
        const meter = {
          id: `mtr_test_${++seq}`,
          object: "billing.meter",
          event_name: form.get("event_name"),
          display_name: form.get("display_name"),
          status: "active",
          livemode: state.livemode,
        };
        state.meters.push(meter);
        return send(res, 200, meter);
      }
      const reactivate = /^\/v1\/billing\/meters\/([^/]+)\/reactivate$/.exec(path);
      if (reactivate && method === "POST") {
        const meter = state.meters.find((m) => m.id === reactivate[1]);
        if (!meter) return missing(res, "meter");
        meter.status = "active";
        return send(res, 200, meter);
      }
      const product = /^\/v1\/products\/([^/]+)$/.exec(path);
      if (product && method === "GET") {
        const p = state.products.get(product[1] ?? "");
        return p ? send(res, 200, p) : missing(res, "product");
      }
      if (product && method === "POST") {
        const p = state.products.get(product[1] ?? "");
        if (!p) return missing(res, "product");
        if (form.has("active")) p.active = form.get("active") === "true";
        if (form.has("unit_label")) p.unit_label = form.get("unit_label");
        return send(res, 200, p);
      }
      if (path === "/v1/products" && method === "POST") {
        const id = form.get("id") ?? `prod_${++seq}`;
        const p = {
          id,
          object: "product",
          name: form.get("name"),
          active: true,
          unit_label: form.get("unit_label"),
          livemode: state.livemode,
        };
        state.products.set(id, p);
        return send(res, 200, p);
      }
      if (path === "/v1/prices" && method === "GET") {
        const keys = [...url.searchParams.entries()]
          .filter(([k]) => k.startsWith("lookup_keys"))
          .map(([, v]) => v);
        const active = url.searchParams.get("active");
        const data = state.prices.filter(
          (p) =>
            keys.includes(String(p.lookup_key)) && (active === null || String(p.active) === active),
        );
        return send(res, 200, list(data, path));
      }
      if (path === "/v1/prices" && method === "POST") {
        const price = {
          id: `price_${++seq}`,
          object: "price",
          active: true,
          currency: form.get("currency"),
          product: form.get("product"),
          unit_amount: Number(form.get("unit_amount")),
          lookup_key: form.get("lookup_key"),
          recurring: {
            interval: form.get("recurring[interval]"),
            usage_type: form.get("recurring[usage_type]"),
            meter: form.get("recurring[meter]"),
          },
          livemode: state.livemode,
        };
        state.prices.push(price);
        return send(res, 200, price);
      }
      send(res, 404, {
        error: { type: "invalid_request_error", message: `fake: ${method} ${path}` },
      });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake = Object.assign(state, {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
  return fake as FakeStripeTdm88;
}
