import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => {
  const noop = () => {};
  const log: Record<string, unknown> = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
  log.child = () => log;
  return { logger: log };
});

const storeHolder = vi.hoisted(() => ({ store: null as unknown }));
vi.mock("../services/plugin-job-store.js", () => ({
  pluginJobStore: () => storeHolder.store,
}));

import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeJob() {
  return {
    id: "job-1",
    pluginId: "plugin-1",
    jobKey: "nightly",
    schedule: "* * * * *",
    status: "active",
    nextRunAt: new Date(Date.now() - 60_000),
  };
}

function setup() {
  const job = makeJob();
  let rows: unknown[] = [job];
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
    // dispatch() reserves the run in a transaction: lock the job row, then
    // check for outstanding runs. Both are served from the in-memory fixture.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: (cols?: unknown) => ({
          from: () => ({
            where: () =>
              cols
                ? { limit: () => Promise.resolve([]) }
                : { for: () => Promise.resolve([job]) },
          }),
        }),
      }),
  };
  const advance = deferred();
  const jobStore = {
    getJobById: vi.fn().mockResolvedValue(job),
    createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
    markRunning: vi.fn().mockResolvedValue(undefined),
    completeRun: vi.fn().mockResolvedValue(undefined),
    updateRunTimestamps: vi.fn().mockImplementation(() => advance.promise),
  };
  storeHolder.store = jobStore;
  const workerManager = {
    isRunning: vi.fn().mockReturnValue(true),
    call: vi.fn().mockResolvedValue(undefined),
  };
  const scheduler = createPluginJobScheduler({
    db: db as never,
    jobStore: jobStore as never,
    workerManager: workerManager as never,
  });
  return {
    job,
    advance,
    jobStore,
    scheduler,
    setRows: (next: unknown[]) => {
      rows = next;
    },
  };
}

// The scheduler only accepts work after start(): the upstream push-driven
// scheduler is armed through a delivery-work coordinator. Start it with no due
// rows so the initial reconciliation run is a no-op, then expose the due job.
async function startScheduler(
  ctx: ReturnType<typeof setup>,
  stoppers: Array<() => Promise<void>>,
) {
  const due = ctx.job;
  ctx.setRows([]);
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []), transaction: vi.fn() });
  const coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError: () => {} });
  await ctx.scheduler.start(coordinator);
  stoppers.push(() => ctx.scheduler.stop(), () => coordinator.stop());
  ctx.setRows([due]);
}

describe("plugin job scheduler overlap prevention", () => {
  const stoppers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const stop of stoppers.splice(0)) await stop();
  });

  it("keeps a scheduled job active until its schedule pointer is advanced", async () => {
    const ctx = setup();
    const { job, advance, jobStore, scheduler, setRows } = ctx;
    await startScheduler(ctx, stoppers);

    const tickPromise = scheduler.tick();
    await vi.waitFor(() => expect(jobStore.updateRunTimestamps).toHaveBeenCalledTimes(1));

    // The run itself is finished, but nextRunAt is still stale.
    setRows([]);
    await expect(scheduler.triggerJob(job.id)).rejects.toThrow(/already running/);
    expect(scheduler.diagnostics().activeJobIds).toEqual([job.id]);

    advance.resolve();
    await tickPromise;

    expect(scheduler.diagnostics().activeJobIds).toEqual([]);
    jobStore.createRun.mockResolvedValueOnce({ id: "run-2" });
    await expect(scheduler.triggerJob(job.id)).resolves.toEqual({
      runId: "run-2",
      jobId: job.id,
    });
  });

  it("releases the job when advancing the schedule pointer fails", async () => {
    const ctx = setup();
    const { job, jobStore, scheduler, setRows } = ctx;
    await startScheduler(ctx, stoppers);
    jobStore.updateRunTimestamps.mockRejectedValue(new Error("db down"));

    await scheduler.tick();

    expect(scheduler.diagnostics().activeJobIds).toEqual([]);
    setRows([]);
    jobStore.createRun.mockResolvedValueOnce({ id: "run-3" });
    await expect(scheduler.triggerJob(job.id)).resolves.toMatchObject({ runId: "run-3" });
  });
});
