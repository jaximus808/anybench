// Send (or preview) a run's owner email by hand: the same path as the run.notify job
// (apps/server/src/jobs/run-notify.ts), for one run, to that run's OWNER only.
//
//   node --env-file=.env --import tsx scripts/ops/send-run-email.ts <run_id> [--dry-run] [--web-url URL]
//
// Exactly once per (run, state), like the job: a run already emailed for its state is skipped.
// --dry-run renders the email and prints the subject, the masked recipient and the text part.
// Never prints the address or any secret.
import type { RunState } from "@anybench/core";
import { createDb } from "../../apps/server/src/db/client.js";
import {
  defaultRunMailer,
  isNotifyState,
  maskEmail,
  notifySettings,
  sendRunNotification,
  type RunMail,
  type RunMailer,
} from "../../apps/server/src/jobs/run-notify.js";

const unquote = (v: string | undefined) => v?.trim().replace(/^["']|["']$/g, "") || undefined;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const runId = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const wi = args.indexOf("--web-url");
  const webOverride = wi >= 0 ? args[wi + 1] : undefined;
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) {
    console.error("usage: send-run-email.ts <run_id> [--dry-run] [--web-url URL]");
    return 2;
  }
  const env = process.env;
  const config = {
    NOTIFY_EMAIL_ENABLED: unquote(env.NOTIFY_EMAIL_ENABLED) as "0" | "1" | undefined,
    MONID_API_KEY: unquote(env.MONID_API_KEY),
    MONID_BASE_URL: unquote(env.MONID_BASE_URL),
    NOTIFY_FROM_INBOX: unquote(env.NOTIFY_FROM_INBOX),
    OUTREACH_FROM_ADDRESS: unquote(env.OUTREACH_FROM_ADDRESS),
    PUBLIC_WEB_URL: webOverride ?? unquote(env.PUBLIC_WEB_URL),
    COMPANY_POSTAL_ADDRESS: unquote(env.COMPANY_POSTAL_ADDRESS),
  };
  const s = notifySettings(config);
  const url = unquote(env.DATABASE_URL_DIRECT) ?? unquote(env.DATABASE_URL);
  if (!url) {
    console.error("DATABASE_URL_DIRECT / DATABASE_URL is not set");
    return 2;
  }
  if (!dryRun && (!s.enabled || !s.inbox)) {
    console.error(`run emails are off: ${s.off}`);
    return 2;
  }

  const h = createDb(url, { max: 2 });
  try {
    // Plain SQL: this script sits outside the server package's node_modules.
    const { rows } = await h.pool.query<{ state: RunState; email: string | null; login: string }>(
      "select r.state, u.email, u.github_login as login from runs r join users u on u.id = r.owner_id where r.id = $1",
      [runId],
    );
    const row = rows[0];
    if (!row) {
      console.error(`run ${runId} not found`);
      return 1;
    }
    if (!isNotifyState(row.state)) {
      console.error(`run ${runId} is ${row.state}: no email for that state`);
      return 1;
    }
    console.log(
      `run ${runId}: state=${row.state} owner=${row.login} to=${row.email ? maskEmail(row.email) : "(none)"} from=${s.inbox ?? "(none)"} web=${s.webUrl}`,
    );

    let captured: RunMail | null = null;
    const preview: RunMailer = {
      async send(mail) {
        captured = mail;
        throw new Error("dry run");
      },
    };
    const mailer = dryRun ? preview : defaultRunMailer(config, s.inbox!);
    const started = Date.now();
    const out = await sendRunNotification(
      {
        db: h.db,
        mailer,
        webUrl: s.webUrl,
        postalAddress: s.postalAddress,
        logger: {
          info: (o, m) => console.log(m, JSON.stringify(o)),
          warn: (o, m) => console.warn(m, JSON.stringify(o)),
        },
      },
      { run_id: runId, state: row.state },
    ).catch((err: unknown) => {
      if (dryRun && captured) return null;
      throw err;
    });
    if (dryRun) {
      const m = captured as RunMail | null;
      if (!m) {
        console.log("dry run: nothing rendered", JSON.stringify(out));
        return 0;
      }
      console.log(`subject: ${m.subject}\nhtml: ${m.html.length} bytes\n---- text ----\n${m.text}`);
      return 0;
    }
    console.log(
      JSON.stringify({ ...out, sendMs: Date.now() - started, at: new Date().toISOString() }),
    );
    return out && out.kind === "sent" ? 0 : 1;
  } finally {
    await h.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
