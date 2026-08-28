import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Source-only: `tsc` emits compiled *.test.js into dist/ without the
    // __fixtures__ directory those tests read at runtime, so a bare
    // `vitest run` after `pnpm build` would fail on fixture ENOENTs for code
    // that is identical to src. Keep test execution on the source of truth.
    include: ["src/**/*.test.ts"],
  },
});
