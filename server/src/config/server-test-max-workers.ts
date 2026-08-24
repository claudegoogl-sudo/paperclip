import os from "node:os";

export interface ResolveServerTestMaxWorkersOptions {
  /** Raw value of PAPERCLIP_SERVER_TEST_MAX_WORKERS. Defaults to the real env var. */
  override?: string | undefined;
  /** Machine parallelism to clamp against. Defaults to os.availableParallelism(). */
  availableParallelism?: number;
}

// Bounded worker count for the general-server lane. Each embedded-Postgres
// instance costs ~300-500MB RSS and this box is shared by the whole agent
// fleet, so we deliberately cap well below os.availableParallelism() rather
// than fan out to every core. isolate/maxConcurrency/sequence.concurrent
// in vitest.config.ts are what actually fixed the historical within-file
// vi.mock ordering flake (upstream #4448) - they are unrelated to this cap
// and must stay put.
//
// PAPERCLIP_SERVER_TEST_MAX_WORKERS is an escape hatch for larger CI boxes.
// It is still clamped to the machine's own availableParallelism() so a
// mistaken or copy-pasted large value (e.g. 64 on a 4-vCPU box) can't fan
// out more forks - each starting its own embedded Postgres - than the box
// the whole fleet shares actually has cores for.
export function resolveServerTestMaxWorkers(
  options: ResolveServerTestMaxWorkersOptions = {},
): number {
  const {
    override = process.env.PAPERCLIP_SERVER_TEST_MAX_WORKERS,
    availableParallelism = os.availableParallelism(),
  } = options;

  const defaultMaxWorkers = Math.max(1, Math.min(3, Math.floor(availableParallelism / 2)));

  if (!override) return defaultMaxWorkers;

  const parsed = Number.parseInt(override, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultMaxWorkers;

  return Math.min(parsed, availableParallelism);
}
