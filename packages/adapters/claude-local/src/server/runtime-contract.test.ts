import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRuntimeContractFingerprint } from "./runtime-contract.js";

// Mirrors the resume-eligibility predicate in execute.ts: a stored fingerprint
// only busts the session when both it and the current fingerprint are non-empty
// and they differ. Empty on either side => "no opinion" => still resumes.
function canResumeForContract(persisted: string, current: string): boolean {
  const mismatch = current.length > 0 && persisted.length > 0 && persisted !== current;
  return !mismatch;
}

describe("buildRuntimeContractFingerprint", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-contract-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns an empty fingerprint when no inputs are configured (AC4: unconfigured => no-op)", async () => {
    expect(await buildRuntimeContractFingerprint([])).toBe("");
    expect(await buildRuntimeContractFingerprint(["", "   "])).toBe("");
  });

  it("is stable for unchanged inputs and independent of listed order", async () => {
    const a = path.join(dir, "CONTRACT.md");
    const b = path.join(dir, "macjob.py");
    await fs.writeFile(a, "per-object authoring\n");
    await fs.writeFile(b, "print('job')\n");

    const first = await buildRuntimeContractFingerprint([a, b]);
    const reordered = await buildRuntimeContractFingerprint([b, a]);
    const duplicated = await buildRuntimeContractFingerprint([a, b, a]);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered).toBe(first);
    expect(duplicated).toBe(first);
  });

  it("changes when a configured input file's content changes", async () => {
    const contract = path.join(dir, "CONTRACT.md");
    await fs.writeFile(contract, "build123d authoring\n");
    const before = await buildRuntimeContractFingerprint([contract]);

    await fs.writeFile(contract, "per-object authoring\n");
    const after = await buildRuntimeContractFingerprint([contract]);

    expect(after).not.toBe(before);
  });

  it("changes when a file inside a configured directory (MCP config dir) changes", async () => {
    const mcpDir = path.join(dir, "mcp");
    await fs.mkdir(mcpDir);
    await fs.writeFile(path.join(mcpDir, "cadworker.mcp.json"), '{"tool":"build123d"}\n');
    const before = await buildRuntimeContractFingerprint([mcpDir]);

    await fs.writeFile(path.join(mcpDir, "cadworker.mcp.json"), '{"tool":"freecad"}\n');
    const after = await buildRuntimeContractFingerprint([mcpDir]);

    expect(after).not.toBe(before);
  });

  it("distinguishes a missing input from a present one", async () => {
    const p = path.join(dir, "CONTRACT.md");
    const missing = await buildRuntimeContractFingerprint([p]);
    await fs.writeFile(p, "now exists\n");
    const present = await buildRuntimeContractFingerprint([p]);
    expect(missing).toMatch(/^[0-9a-f]{64}$/);
    expect(present).not.toBe(missing);
  });

  it("flips resume-eligibility to false when a persisted input changes, and keeps resuming when unchanged (AC3)", async () => {
    const contract = path.join(dir, "CONTRACT.md");
    await fs.writeFile(contract, "build123d authoring\n");
    const persisted = await buildRuntimeContractFingerprint([contract]);

    // Unchanged inputs still resume.
    const unchanged = await buildRuntimeContractFingerprint([contract]);
    expect(canResumeForContract(persisted, unchanged)).toBe(true);

    // A changed input busts the pinned session.
    await fs.writeFile(contract, "per-object authoring\n");
    const changed = await buildRuntimeContractFingerprint([contract]);
    expect(canResumeForContract(persisted, changed)).toBe(false);
  });

  it("does not bust when the feature is unconfigured on the current run (empty current => resume)", async () => {
    // Session was saved with a fingerprint, but the current run has no configured
    // inputs (empty current). AC4: unconfigured => current behavior (resume).
    expect(canResumeForContract("some-old-fingerprint", "")).toBe(true);
  });

  it("does not bust a legacy session that has no persisted fingerprint", async () => {
    const contract = path.join(dir, "CONTRACT.md");
    await fs.writeFile(contract, "per-object authoring\n");
    const current = await buildRuntimeContractFingerprint([contract]);
    expect(canResumeForContract("", current)).toBe(true);
  });
});
