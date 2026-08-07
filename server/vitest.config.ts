import { defineConfig } from "vitest/config";

import { resolveServerTestMaxWorkers } from "./src/config/server-test-max-workers.js";

// See resolveServerTestMaxWorkers() in src/config/server-test-max-workers.ts
// for the rationale behind this cap. isolate/maxConcurrency/sequence.concurrent
// below are what actually fixed the historical within-file vi.mock ordering
// flake (upstream #4448) - they are unrelated to that cap and must stay put.
export default defineConfig({
  test: {
    environment: "node",
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: resolveServerTestMaxWorkers(),
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
    // Symmetric startup/teardown budget: every embedded-Postgres `beforeAll`
    // already passes `20_000` per-file. Without this line, the matching
    // `afterAll` cleanup hooks run on vitest's 10s default `hookTimeout`, so
    // on a loaded runner teardown overruns the budget and reddens a passing
    // suite. The per-file `beforeAll` 20_000 is preserved (it's a no-op once
    // the global is 20s), but the global is what keeps the teardown side
    // honest. See packages/db/src/test-embedded-postgres.ts for the
    // SIGKILL-escalation path that bounds cleanup() well inside this budget.
    hookTimeout: 20_000,
  },
});
