import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // The DB suites create and migrate a database per file; several worktrees share one Postgres.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
