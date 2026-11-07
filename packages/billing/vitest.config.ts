import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // The DB suites create and migrate a database per file; several worktrees share one Postgres.
      testTimeout: 60_000,
      hookTimeout: 120_000,
    },
  }),
);
