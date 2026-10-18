// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredImportJob,
  importJobStorageKey,
  readStoredImportJob,
  waitForNextImportJobPoll,
  writeStoredImportJob,
} from "./import-job-watch";

describe("importJobStorageKey", () => {
  beforeEach(() => sessionStorage.clear());

  it("scopes the key by company and package name", () => {
    expect(importJobStorageKey("company-1", "pkg-a")).toBe(
      "paperclip:company-import-job:company-1:pkg-a",
    );
  });

  it("produces different keys for different companies or packages", () => {
    const base = importJobStorageKey("company-1", "pkg-a");
    expect(importJobStorageKey("company-2", "pkg-a")).not.toBe(base);
    expect(importJobStorageKey("company-1", "pkg-b")).not.toBe(base);
  });
});

describe("writeStoredImportJob / readStoredImportJob / clearStoredImportJob", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips a stored job through the same key", () => {
    const key = importJobStorageKey("company-1", "pkg-a");
    writeStoredImportJob(key, { jobId: "job-1", pauseAutomations: true });
    expect(readStoredImportJob("company-1")).toEqual({
      jobId: "job-1",
      pauseAutomations: true,
      storageKey: key,
    });
  });

  it("clears a stored job so it is no longer found", () => {
    const key = importJobStorageKey("company-1", "pkg-a");
    writeStoredImportJob(key, { jobId: "job-1", pauseAutomations: false });
    clearStoredImportJob(key);
    expect(readStoredImportJob("company-1")).toBeNull();
  });

  it("returns null when nothing is stored for the company", () => {
    expect(readStoredImportJob("company-missing")).toBeNull();
  });

  it("does not find another company's stored job", () => {
    const key = importJobStorageKey("company-1", "pkg-a");
    writeStoredImportJob(key, { jobId: "job-1", pauseAutomations: false });
    expect(readStoredImportJob("company-2")).toBeNull();
  });

  it("discards and ignores a malformed entry under the company prefix", () => {
    const key = importJobStorageKey("company-1", "pkg-a");
    sessionStorage.setItem(key, "not json");
    expect(readStoredImportJob("company-1")).toBeNull();
    // The malformed entry is discarded during the scan.
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("discards and ignores an entry missing a jobId", () => {
    const key = importJobStorageKey("company-1", "pkg-a");
    sessionStorage.setItem(key, JSON.stringify({ pauseAutomations: true }));
    expect(readStoredImportJob("company-1")).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("defaults pauseAutomations to false when not explicitly true", () => {
    const key = importJobStorageKey("company-1", "pkg-a");
    sessionStorage.setItem(key, JSON.stringify({ jobId: "job-1" }));
    expect(readStoredImportJob("company-1")?.pauseAutomations).toBe(false);
  });

  it("does not disturb entries belonging to other storage keys", () => {
    sessionStorage.setItem("unrelated-key", "keep-me");
    const key = importJobStorageKey("company-1", "pkg-a");
    writeStoredImportJob(key, { jobId: "job-1", pauseAutomations: false });
    readStoredImportJob("company-1");
    expect(sessionStorage.getItem("unrelated-key")).toBe("keep-me");
  });
});

describe("waitForNextImportJobPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after one interval while the document is visible", async () => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    const settled = vi.fn();
    waitForNextImportJobPoll(1000).then(settled);
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalled();
  });

  it("keeps waiting through additional intervals while the tab is hidden", async () => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    const settled = vi.fn();
    waitForNextImportJobPoll(1000).then(settled);

    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).not.toHaveBeenCalled();

    // Tab becomes visible again; the next completed interval resolves.
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toHaveBeenCalled();
  });
});
