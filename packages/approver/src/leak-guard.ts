// The approver must never leak answers or hidden tests. It only ever reads public board text, but
// every string it sends out (a reviewer prompt, a reject reason, a Naïve answer) also goes through
// this guard as defence in depth: scoring-bundle paths and caller-supplied secret snippets refuse.

/** Paths that exist only in the scoring bundle (plan.md 17.2 rule 5). */
const SCORING_PATHS = [
  /(^|[\s/"'`])gates\//,
  /(^|[\s/"'`])reference\//,
  /(^|[\s/"'`])proof\/oracle\//,
];
const SCORING_WORDS = [/hidden[ -]tests?/i, /\brubric\.md\b/i];

export class LeakError extends Error {
  constructor(
    message: string,
    readonly where: string,
  ) {
    super(message);
    this.name = "LeakError";
  }
}

export interface LeakGuardOptions {
  /**
   * Exact snippets that must never leave the approver (lines of hidden tests, reference outputs).
   * Snippets shorter than 12 characters are ignored so common words don't trip it.
   */
  forbidden?: readonly string[];
}

export class LeakGuard {
  readonly #forbidden: string[];

  constructor(options: LeakGuardOptions = {}) {
    this.#forbidden = (options.forbidden ?? []).map((s) => s.trim()).filter((s) => s.length >= 12);
  }

  /** Throws LeakError if `text` names scoring material. Returns `text` for chaining. */
  check(text: string, where: string): string {
    for (const re of [...SCORING_PATHS, ...SCORING_WORDS]) {
      if (re.test(text))
        throw new LeakError(`approver output mentions scoring material (${re})`, where);
    }
    for (const s of this.#forbidden) {
      if (text.includes(s))
        throw new LeakError("approver output contains a forbidden snippet", where);
    }
    return text;
  }

  /** Like `check` but returns a boolean. */
  isClean(text: string): boolean {
    try {
      this.check(text, "probe");
      return true;
    } catch {
      return false;
    }
  }
}
