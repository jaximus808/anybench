// TDM-14: pino header redaction + core redactor over every line.
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/lib/logger.js";

function collect() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  return {
    lines,
    raw,
    destination: {
      write(s: string) {
        raw.push(s);
        lines.push(JSON.parse(s) as Record<string, unknown>);
      },
    },
  };
}

describe("createLogger (TDM-14)", () => {
  it("blanks authorization and cookie headers", () => {
    const sink = collect();
    const log = createLogger({ destination: sink.destination });
    log.info(
      { req: { headers: { authorization: "Bearer abc123", cookie: "sid=xyz", accept: "*/*" } } },
      "r",
    );
    const req = sink.lines[0]!.req as { headers: Record<string, string> };
    expect(req.headers.authorization).toBe("[REDACTED]");
    expect(req.headers.cookie).toBe("[REDACTED]");
    expect(req.headers.accept).toBe("*/*");
    expect(sink.raw.join("")).not.toMatch(/abc123|sid=xyz/);
  });

  it("redacts secrets in scope and known key patterns in messages, fields and errors", () => {
    const sink = collect();
    const dbUrl = "postgres://anybench:s3cr3t-pw@db.example/anybench";
    const log = createLogger({ destination: sink.destination, secrets: { DATABASE_URL: dbUrl } });
    const stripe = "sk_live_" + "Zz9Yy8Xx7Ww6Vv5";
    log.error(
      { err: new Error(`connect ${dbUrl} failed`), detail: `key=${stripe}` },
      `using ${dbUrl}`,
    );
    const out = sink.raw.join("");
    expect(out).not.toContain("s3cr3t-pw");
    expect(out).not.toContain(stripe);
    expect(out).toContain("[REDACTED:DATABASE_URL]");
    expect(out).toContain("[REDACTED:STRIPE_SECRET_KEY]");
    expect(sink.lines[0]!.msg).toBe("using [REDACTED:DATABASE_URL]");
  });
});
