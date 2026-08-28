import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Every suite in this package boots its own embedded Postgres; running
    // files in parallel multiplies postgres processes past what CI runners can
    // schedule, which shows up as pool/hook timeouts rather than test
    // failures. Serialize the files; each suite is short once it has a
    // database, and the lane becomes deterministic.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
