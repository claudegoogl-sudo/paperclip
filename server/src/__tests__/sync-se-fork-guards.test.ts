import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-sentinel regression tests for the three SE-triaged fork findings that
// the upstream v2026.1117.0 sync must keep (route-level coverage needs the full
// issues router harness; these pin the guards so a later merge cannot drop them).
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("SE-triaged fork guards survive the upstream sync", () => {
  it("run-preparation forbids PAPERCLIP_BRIDGE_API_KEY in generic env bindings", () => {
    const src = read("../services/heartbeat/run-preparation.ts");
    const start = src.indexOf("const FORBIDDEN_ENV_BINDING_KEYS = new Set([");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("]);", start));
    expect(block).toContain("SANCTIONED_BRIDGE_ENV_KEY");
    expect(block).toContain('"PAPERCLIP_API_KEY"');
    expect(read("../services/task-bridge-keys.ts")).toContain("PAPERCLIP_BRIDGE_API_KEY");
  });

  it("issue comment route refuses plugin_ops keys that reopen, resume, interrupt or comment on closed issues", () => {
    const src = read("../routes/issues.ts");
    const marker = 'boardKeyScope?.kind === "plugin_ops"';
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const window = src.slice(at, at + 700);
    expect(window).toContain("req.body.reopen === true");
    expect(window).toContain("req.body.resume === true");
    expect(window).toContain("req.body.interrupt === true");
    expect(window).toContain("isClosedIssueStatus(issue.status)");
    expect(window).toContain("res.status(403)");
  });

  it("cross-company PATCH skips the foreign-agent read gate (field guard already ran)", () => {
    const src = read("../routes/issues.ts");
    expect(src).toContain("if (!crossCompanyPatch && !(await assertIssueReadAllowed(req, res, existing))) return;");
  });
});
