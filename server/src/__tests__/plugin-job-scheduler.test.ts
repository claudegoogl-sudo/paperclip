import { describe, expect, it, vi } from "vitest";

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
  };
  const advance = deferred();
  const jobStore = {
    getJobById: vi.fn().mockResolvedValue(job),
    createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
    markRunning: vi.fn().mockResolvedValue(undefined),
    completeRun: vi.fn().mockResolvedValue(undefined),
    updateRunTimestamps: vi.fn().mockImplementation(() => advance.promise),
  };
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

describe("plugin job scheduler overlap prevention", () => {
  it("keeps a scheduled job active until its schedule pointer is advanced", async () => {
    const { job, advance, jobStore, scheduler, setRows } = setup();

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
    const { job, jobStore, scheduler, setRows } = setup();
    jobStore.updateRunTimestamps.mockRejectedValue(new Error("db down"));

    await scheduler.tick();

    expect(scheduler.diagnostics().activeJobIds).toEqual([]);
    setRows([]);
    jobStore.createRun.mockResolvedValueOnce({ id: "run-3" });
    await expect(scheduler.triggerJob(job.id)).resolves.toMatchObject({ runId: "run-3" });
  });
});
