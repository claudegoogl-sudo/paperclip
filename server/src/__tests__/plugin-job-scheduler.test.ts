import { describe, expect, it, vi } from "vitest";

const storeHolder = vi.hoisted(() => ({ store: undefined as unknown }));
vi.mock("../services/plugin-job-store.js", () => ({ pluginJobStore: () => storeHolder.store }));

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

import { pluginJobs } from "@paperclipai/db";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";

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
    lastRunAt: null,
    nextRunAt: new Date(Date.now() - 60_000),
  };
}

function setup() {
  const job = makeJob();
  const chain = (rows: unknown[]) =>
    Object.assign(Promise.resolve(rows), {
      for: () => Promise.resolve(rows),
      limit: () => Promise.resolve([]),
    });
  const select = () => ({
    from: (table: unknown) => ({
      where: () => (table === pluginJobs ? chain([job]) : chain([])),
    }),
  });
  const tx = { select, execute: vi.fn().mockResolvedValue(undefined) };
  const db = {
    select,
    transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
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
  // The scheduler only accepts work once started; a stub coordinator keeps
  // this a unit test of the overlap logic.
  const started = scheduler.start({
    register: () => ({ ready: Promise.resolve(), wake: () => {}, stop: async () => {} }),
  } as never);
  return { started, job, advance, jobStore, scheduler };
}

describe("plugin job scheduler overlap prevention", () => {
  it("keeps a scheduled job active until its schedule pointer is advanced", async () => {
    const { job, advance, jobStore, scheduler, started } = setup();
    await started;

    const tickPromise = scheduler.tick();
    await vi.waitFor(() => expect(jobStore.updateRunTimestamps).toHaveBeenCalledTimes(1));

    // The run itself is finished, but nextRunAt is still stale.
    await expect(scheduler.triggerJob(job.id)).rejects.toThrow(/already running/);
    expect(scheduler.diagnostics().activeJobIds).toEqual([job.id]);

    advance.resolve();
    await tickPromise;
    await vi.waitFor(() => expect(scheduler.diagnostics().activeJobIds).toEqual([]));

    jobStore.createRun.mockResolvedValueOnce({ id: "run-2" });
    await expect(scheduler.triggerJob(job.id)).resolves.toEqual({
      runId: "run-2",
      jobId: job.id,
    });
  });

  it("retains the failed settlement, releases the slot, and retries it on the next tick", async () => {
    const { job, jobStore, scheduler, started } = setup();
    await started;
    jobStore.updateRunTimestamps.mockReset();
    jobStore.updateRunTimestamps.mockRejectedValueOnce(new Error("db down")).mockResolvedValue(undefined);

    await scheduler.tick();
    await vi.waitFor(() => expect(scheduler.diagnostics().activeJobIds).toEqual([]));

    // The unsettled completion still blocks a manual run until it is persisted.
    await expect(scheduler.triggerJob(job.id)).rejects.toThrow(/already running/);
    await scheduler.tick();
    expect(jobStore.updateRunTimestamps).toHaveBeenCalledTimes(2);

    jobStore.createRun.mockResolvedValueOnce({ id: "run-3" });
    await expect(scheduler.triggerJob(job.id)).resolves.toMatchObject({ runId: "run-3" });
  });
});
