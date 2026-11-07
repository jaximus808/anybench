// TDM-47: per-trial runner tokens (HMAC over trial id + attempt, constant-time verify, expiry).
import { describe, expect, it } from "vitest";
import {
  bearerToken,
  checkRunnerTokenLive,
  mintRunnerToken,
  RUNNER_TOKEN_GRACE_MS,
  RUNNER_TOKEN_PREFIX,
  verifyRunnerToken,
} from "../src/lib/runner-token.js";

const SECRET = "tdm47-test-secret-0123456789abcdef-0123456789";
const TRIAL = "0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OTHER = "0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

describe("runner tokens (TDM-47)", () => {
  it("mints a stable, prefixed token the runner's trial.json accepts (>= 16 chars)", () => {
    const t = mintRunnerToken(SECRET, TRIAL, 1);
    expect(t.startsWith(RUNNER_TOKEN_PREFIX)).toBe(true);
    expect(t.length).toBeGreaterThanOrEqual(16);
    expect(mintRunnerToken(SECRET, TRIAL.toUpperCase(), 1)).toBe(t);
    expect(verifyRunnerToken(SECRET, t, TRIAL, 1)).toBe(true);
  });

  it("rejects another trial, another attempt, another secret and malformed tokens", () => {
    const t = mintRunnerToken(SECRET, TRIAL, 1);
    expect(verifyRunnerToken(SECRET, t, OTHER, 1)).toBe(false);
    expect(verifyRunnerToken(SECRET, t, TRIAL, 2)).toBe(false);
    expect(verifyRunnerToken(`${SECRET}x`, t, TRIAL, 1)).toBe(false);
    for (const bad of [
      "",
      "t",
      RUNNER_TOKEN_PREFIX,
      t.slice(0, -1),
      `${t}A`,
      t.slice(RUNNER_TOKEN_PREFIX.length),
    ]) {
      expect(verifyRunnerToken(SECRET, bad, TRIAL, 1)).toBe(false);
    }
  });

  it("refuses a short secret and a non-positive attempt", () => {
    expect(() => mintRunnerToken("short", TRIAL, 1)).toThrow(/at least 32/);
    expect(() => mintRunnerToken(SECRET, TRIAL, 0)).toThrow(RangeError);
  });

  it("parses Bearer headers", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc ")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it("expires with the trial: superseded attempt, or terminal past the grace window", () => {
    const now = new Date("2026-11-07T22:00:00Z");
    const live = { attempt: 2, state: "running" as const, endedAt: null };
    expect(checkRunnerTokenLive(live, 2, now)).toEqual({ ok: true });
    expect(checkRunnerTokenLive(live, 1, now)).toEqual({ ok: false, reason: "attempt_superseded" });
    const justEnded = {
      attempt: 2,
      state: "failed_subject" as const,
      endedAt: new Date(now.getTime() - 1000),
    };
    expect(checkRunnerTokenLive(justEnded, 2, now)).toEqual({ ok: true });
    const longEnded = {
      ...justEnded,
      endedAt: new Date(now.getTime() - RUNNER_TOKEN_GRACE_MS - 1),
    };
    expect(checkRunnerTokenLive(longEnded, 2, now)).toEqual({ ok: false, reason: "trial_ended" });
    expect(checkRunnerTokenLive({ attempt: 2, state: "done", endedAt: null }, 2, now)).toEqual({
      ok: false,
      reason: "trial_ended",
    });
  });
});
