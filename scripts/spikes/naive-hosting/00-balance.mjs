// Records credits balance, subscription and what the key can do.
/* global  */
import { naive, step } from "./lib.mjs";
const c = naive();
await step("credits.show", () => c.credits.show());
await step("credits.subscription", () => c.credits.subscription());
await step("computers.list", async () =>
  (await c.computers.list({ limit: 20 })).data.map((x) => ({
    id: x.id,
    name: x.name,
    status: x.status,
  })),
);
await step("apps.list", async () =>
  (await c.apps.list({ limit: 20 })).data.map((x) => ({
    id: x.id,
    name: x.name,
    type: x.type,
    status: x.status,
    url: x.url,
  })),
);
await step("domains.list", async () =>
  (await c.domains.list({ limit: 20 })).data.map((x) => ({
    id: x.id,
    name: x.name,
    kind: x.kind,
    status: x.status,
  })),
);
