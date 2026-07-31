import os from "node:os";
import { defineConfig } from "vitest/config";

// Bounded worker count for the general-server lane. Each embedded-Postgres
// instance costs ~300-500MB RSS and this box is shared by the whole agent
// fleet, so we deliberately cap well below os.availableParallelism() rather
// than fan out to every core. isolate/maxConcurrency/sequence.concurrent
// below are what actually fixed the historical within-file vi.mock ordering
// flake (upstream #4448) - they are unrelated to this cap and must stay put.
function resolveServerTestMaxWorkers(): number {
  const defaultMaxWorkers = Math.max(1, Math.min(3, Math.floor(os.availableParallelism() / 2)));

  const override = process.env.PAPERCLIP_SERVER_TEST_MAX_WORKERS;
  if (!override) return defaultMaxWorkers;

  const parsed = Number.parseInt(override, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultMaxWorkers;
  return parsed;
}

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
  },
});
