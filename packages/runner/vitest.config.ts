import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    // TDM-247: what build-bin.mjs compiles in (bun --define), so tests see a real commit.
    define: {
      __ANYBENCH_RUNNER_BUILD__: JSON.stringify(
        "anybench-runner-build:0123456789abcdef0123456789abcdef01234567",
      ),
    },
  }),
);
