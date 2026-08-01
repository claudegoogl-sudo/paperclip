import { defineConfig } from "vitest/config";

import { resolveServerTestMaxWorkers } from "./src/config/server-test-max-workers.js";

// See resolveServerTestMaxWorkers() in src/config/server-test-max-workers.ts
// for the rationale behind this cap. isolate/maxConcurrency/sequence.concurrent
// below are what actually fixed the historical within-file vi.mock ordering
// flake (upstream #4448) - they are unrelated to that cap and must stay put.
export default defineConfig({
  test: {
    environment: "node",
    // Each server suite boots + tears down its own embedded Postgres in
    // beforeAll/afterAll. Under the loaded serial shard (maxWorkers=1) the
    // graceful shutdown can occasionally cross vitest's default 10s hookTimeout,
    // producing flaky "Hook timed out in 10000ms" afterAll failures on CI. Give
    // the boot/teardown hooks generous headroom; 30s is far above the observed
    // worst-case teardown yet still catches a genuinely hung hook. teardownTimeout
    // mirrors it for the same reason.
    hookTimeout: 30000,
    teardownTimeout: 30000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: resolveServerTestMaxWorkers(),
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
