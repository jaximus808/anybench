// worker-hardening: which provider errors trip the outage breaker (5xx / 429, anywhere on the
// cause chain) and that the Naïve adapter keeps the HTTP status.
import { NaiveError } from "@anybench/naive";
import { describe, expect, it } from "vitest";
import {
  isProviderOutageError,
  ProviderError,
  providerErrorFromNaive,
  ProviderValidationError,
} from "../src/index.js";

function naiveError(status: number, code: string, message: string): NaiveError {
  return new NaiveError(message, { status, code });
}

describe("isProviderOutageError (worker-hardening)", () => {
  it("is true for 5xx and 429, false for 4xx and status-less errors", () => {
    expect(isProviderOutageError(new ProviderError("provider", "x", { status: 500 }))).toBe(true);
    expect(isProviderOutageError(new ProviderError("provider", "x", { status: 503 }))).toBe(true);
    expect(isProviderOutageError(new ProviderError("capacity", "x", { status: 429 }))).toBe(true);
    expect(isProviderOutageError(new ProviderValidationError("x", { status: 422 }))).toBe(false);
    expect(isProviderOutageError(new ProviderError("provider", "fetch failed"))).toBe(false);
    expect(isProviderOutageError(new Error("boom"))).toBe(false);
    expect(isProviderOutageError(undefined)).toBe(false);
  });

  it("follows the cause chain (an InfraFailure / GateInfraError wrapping the provider error)", () => {
    const inner = new ProviderError("provider", "sandbox request failed", { status: 500 });
    const outer = new Error("could not mint", { cause: new Error("wrap", { cause: inner }) });
    expect(isProviderOutageError(outer)).toBe(true);
  });

  it("providerErrorFromNaive keeps the status of a Naïve 500", () => {
    const e = providerErrorFromNaive(naiveError(500, "internal", "the sandbox request failed"));
    expect(e.status).toBe(500);
    expect(isProviderOutageError(e)).toBe(true);
    expect(providerErrorFromNaive(naiveError(404, "not_found", "gone")).status).toBe(404);
  });
});
