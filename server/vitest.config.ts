import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { resolveServerTestMaxWorkers } from "./src/config/server-test-max-workers.js";

// See resolveServerTestMaxWorkers() in src/config/server-test-max-workers.ts
// for the rationale behind this cap. isolate/maxConcurrency/sequence.concurrent
// below are what actually fixed the historical within-file vi.mock ordering
// flake (upstream #4448) - they are unrelated to that cap and must stay put.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@paperclipai\/paperclip-runner\/live$/,
        replacement: fileURLToPath(
          new URL("../packages/paperclip-runner/src/live/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@paperclipai\/paperclip-runner$/,
        replacement: fileURLToPath(
          new URL("../packages/paperclip-runner/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "node",
    // The fork's host-wide run ceiling defaults to the vCPU count, so heartbeat suites that start several
    // runs behave differently on a 4-vCPU CI runner than on a dev host. Pin a runner-independent ceiling.
    env: { PAPERCLIP_MAX_CONCURRENT_RUNS_HOST: process.env.PAPERCLIP_MAX_CONCURRENT_RUNS_HOST ?? "8" },
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Embedded-Postgres suites boot in beforeAll and tear down in afterAll. On a
    // loaded runner both ends can outlast vitest's 10s defaults and redden a
    // passing suite, so the global budget is explicit. Under the loaded serial
    // shard (maxWorkers=1) the graceful shutdown can occasionally cross the
    // default, producing flaky "Hook timed out in 10000ms" afterAll failures on
    // CI. 30s is far above the observed worst-case teardown yet still catches a
    // genuinely hung hook; teardownTimeout mirrors it. See
    // packages/db/src/test-embedded-postgres.ts for the SIGKILL-escalation path
    // that bounds cleanup() well inside this budget.

    hookTimeout: 30000,
    teardownTimeout: 30000,
    // The route/authz suites import very large modules (for example
    // src/routes/issues.ts and its dependency graph). The first test in each
    // file pays the one-time transform cost inside its own timeout budget. On
    // the loaded serial shard (maxWorkers=1) that cost can cross vitest's
    // default 5s testTimeout and fail the first test, which also lets its
    // fire-and-forget wake leak into the next test. Give each test generous
    // headroom; 15s is far above the observed module-load cost yet still
    // catches a genuinely hung test well inside the 20 minute job limit.
    testTimeout: 15000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: resolveServerTestMaxWorkers(),
    pool: "forks",
    // Server suites share process state and one embedded Postgres instance,
    // so tests inside a file must run one at a time. Do not set
    // sequence.concurrent to true.
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
