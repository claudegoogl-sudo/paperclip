import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Regression coverage for the CODEX_HOME temp-dir leak fixed in
// setup-supertest.ts. That setup file runs once per
// vitest worker: when CODEX_HOME is not already set it mkdtemps a
// `paperclip-vitest-codex-home-*` dir and must register cleanup so the worker
// does not leak it on exit. Vitest's fork pool terminates idle workers with
// SIGTERM (see vitest.config.ts), which does NOT fire the "exit" event, so the
// setup wires both an "exit" handler and signal handlers. The actual removal
// happens after this worker exits and cannot be observed from inside it; here
// we assert the observable preconditions — the dir this worker created exists
// and every teardown handler is registered — so deleting any handler reddens
// this test.
const CODEX_HOME = process.env.CODEX_HOME;
const createdByOurSetup = Boolean(CODEX_HOME?.includes("paperclip-vitest-codex-home-"));

describe.runIf(createdByOurSetup)("setup-supertest CODEX_HOME teardown wiring", () => {
  it("created the worker-scoped codex home with the synthetic auth.json", () => {
    expect(CODEX_HOME).toBeDefined();
    const authPath = path.join(CODEX_HOME as string, "auth.json");
    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.readFileSync(authPath, "utf8")).toContain("sk-vitest");
  });

  it("registered exit and termination-signal cleanup handlers", () => {
    // "exit" alone is insufficient: SIGTERM-terminated fork workers never emit
    // it, which is why the original code leaked one dir per worker.
    expect(process.listenerCount("exit")).toBeGreaterThan(0);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      expect(process.listenerCount(signal)).toBeGreaterThan(0);
    }
  });
});
