import { describe, expect, it } from "vitest";
import { questionTitle } from "../lib/question-title";

describe("questionTitle", () => {
  it("drops the Preferences block the New run form appends", () => {
    const q =
      "is it faster than plain claude code\n\nPreferences:\n- Runs per setup and task: 5\n- Approvals: A reviewer agent plays the human\n- Send results to: email";
    expect(questionTitle(q)).toBe("is it faster than plain claude code");
  });
  it("is case-insensitive and tolerates leading spaces", () => {
    expect(questionTitle("Is it better?\n  preferences:\n- x")).toBe("Is it better?");
  });
  it("leaves a question without preferences alone (trimmed)", () => {
    expect(questionTitle("  Is it cheaper?  ")).toBe("Is it cheaper?");
    expect(questionTitle("Line one\nline two")).toBe("Line one\nline two");
  });
  it("only cuts at a line that starts with Preferences:", () => {
    expect(questionTitle("Do my Preferences: matter?")).toBe("Do my Preferences: matter?");
  });
});
