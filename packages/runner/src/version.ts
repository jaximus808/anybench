/** Recorded in status.json, machine.json and `runner --version`. Bump with behaviour changes. */
export const RUNNER_VERSION = "0.1.0";

// TDM-247: scripts/build-bin.mjs compiles `anybench-runner-build:<commit>[-dirty]` in here with
// `bun build --define`; the deploy and the env build read the same string back out of the binary
// (packages/envs runner-stamp.ts). Under plain node (dist/) there is no define and the commit is
// "unknown"; vitest.config.ts defines a fixed one.
declare const __ANYBENCH_RUNNER_BUILD__: string | undefined;
const PREFIX = "anybench-runner-build:";
const BUILD = typeof __ANYBENCH_RUNNER_BUILD__ === "string" ? __ANYBENCH_RUNNER_BUILD__ : "";
const commit = BUILD.startsWith(PREFIX) ? BUILD.slice(PREFIX.length) : "";

/**
 * `<40 hex>` or `<40 hex>-dirty`: the newest commit that changed the runner's build inputs, as
 * compiled into this binary. "unknown" when the runner was not built by build-bin.mjs.
 */
export const RUNNER_COMMIT = /^[0-9a-f]{40}(-dirty)?$/.test(commit) ? commit : "unknown";

/** `runner --version`: `0.1.0 <commit>`. */
export const RUNNER_VERSION_LINE = `${RUNNER_VERSION} ${RUNNER_COMMIT}`;
