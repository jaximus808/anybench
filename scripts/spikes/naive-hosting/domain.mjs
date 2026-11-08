// TDM-170 part 3: could connectDomain serve api.anybench.jaxonp.com? Records only; no DNS change.
// Usage: SPIKE_STATE=<file> ./run.sh domain.mjs probe | cleanup
/* global process */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { naive, step, sleep } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STATE = process.env.SPIKE_STATE ?? join(here, ".state.json");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const c = naive();
const NAME = process.env.SPIKE_DOMAIN ?? "api.anybench.jaxonp.com";

switch (process.argv[2]) {
  case "probe": {
    const d = await step(
      "domains.create external receive=false",
      () => c.domains.create({ name: NAME, kind: "external", receive: false }),
      { rethrow: true },
    );
    state.domainId = d.id;
    save();
    await step("domains.records", () => c.domains.records(d.id));
    await step("apps.connectDomain", () => c.apps.connectDomain(state.appId, d.id));
    await sleep(5000);
    await step("apps.domains", () => c.apps.domains(state.appId));
    await step("domains.get (after connect)", () => c.domains.get(d.id));
    await step("domains.verify (DNS not changed; expect pending)", () => c.domains.verify(d.id));
    break;
  }
  case "cleanup":
    await step("apps.disconnectDomain", () => c.apps.disconnectDomain(state.appId, NAME));
    if (state.domainId) await step("domains.delete", () => c.domains.delete(state.domainId));
    await step("domains.list", () => c.domains.list({ limit: 20 }));
    break;
}
