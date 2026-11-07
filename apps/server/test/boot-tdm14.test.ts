// TDM-14: the real entries refuse to boot on a bad env, with every problem on stderr and exit 1.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));

function boot(entry: string, env: Record<string, string>) {
  // A clean env (PATH/HOME only), so a developer's shell or .env cannot make this pass or fail.
  return spawnSync(process.execPath, ["--import", "tsx", entry], {
    cwd: SERVER_DIR,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    encoding: "utf8",
    timeout: 25_000,
  });
}

describe("entry boot failure (TDM-14)", () => {
  it.each(["src/main.ts", "src/worker.ts"])("%s exits 1 and names every bad var", (entry) => {
    const r = boot(entry, {
      NODE_ENV: "production",
      BILLING_MODE: "off",
      PORT: "not-a-port",
      DATABASE_URL: "postgres://u@h/db",
      DATABASE_URL_DIRECT: "postgres://u@h/db",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to boot");
    expect(r.stderr).toContain("PORT:");
    // Schema errors are reported first; fix those and the boot assertions run.
    const r2 = boot(entry, {
      NODE_ENV: "production",
      BILLING_MODE: "off",
      DATABASE_URL: "postgres://u@h/db",
      DATABASE_URL_DIRECT: "postgres://u@h/db",
    });
    expect(r2.status).toBe(1);
    expect(r2.stderr).toMatch(/BILLING_MODE: off is only allowed in local dev/);
  });

  it("src/main.ts reports a Stripe key/mode mismatch", () => {
    const r = boot("src/main.ts", {
      BILLING_MODE: "live",
      STRIPE_SECRET_KEY: "sk_test_A1b2C3d4E5f6G7h8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /STRIPE_SECRET_KEY: must start with sk_live_ or rk_live_ for live mode/,
    );
    expect(r.stderr).not.toContain("A1b2C3d4E5f6G7h8");
  });
});
