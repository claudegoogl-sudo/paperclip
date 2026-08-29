import { defineConfig } from "vitest/config";

import { resolveServerTestMaxWorkers } from "./src/config/server-test-max-workers.js";

// See resolveServerTestMaxWorkers() in src/config/server-test-max-workers.ts
// for the rationale behind this cap. isolate/maxConcurrency/sequence.concurrent
// below are what actually fixed the historical within-file vi.mock ordering
// flake (upstream #4448) - they are unrelated to that cap and must stay put.
export default defineConfig({
  test: {
    environment: "node",
    // Embedded-Postgres suites boot in beforeAll and tear down in afterAll. On a
    // loaded runner both ends can outlast vitest's 10s defaults and redden a
    // passing suite, so the global budget is explicit: hooks run with 20s
    // (matching the per-file `beforeAll` 20_000 that every embedded-Postgres
    // suite already passes) and teardown keeps 30s of headroom. See
    // packages/db/src/test-embedded-postgres.ts for the SIGKILL-escalation path
    // that bounds cleanup() well inside this budget.
    hookTimeout: 20_000,
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
