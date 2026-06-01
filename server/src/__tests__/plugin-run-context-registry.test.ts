/**
 * PLA-768 — run-context registry: dispatch vs. worker-lifetime service entries.
 *
 * The registry is the host's authoritative `(pluginDbId, runId) → context`
 * source. Dispatch entries are short-lived and TTL-swept as an orphan safety
 * net; service entries back a worker-lifetime poll loop (which may run for
 * hours) and MUST be exempt from the sweep and removed only explicitly on
 * worker stop.
 */

import { describe, expect, it } from "vitest";
import { createPluginRunContextRegistry } from "../services/plugin-run-context-registry.js";

const PLUGIN = "plugin-db-1";
const DISPATCH_RUN = "dispatch-run-1";
const SERVICE_RUN = "service-run-1";
const BG_RUN = "background-run-1";
const TRIGGER_COMPANY = "company-trigger-1";

function dispatchCtx(runId: string, registeredAt: number) {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    runId,
    projectId: "proj-1",
    toolName: "tool.x",
    registeredAt,
  };
}

describe("plugin run-context registry (PLA-768)", () => {
  it("stores and returns a service entry discriminated by kind", () => {
    const reg = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    reg.registerService(PLUGIN, SERVICE_RUN);

    const got = reg.get(PLUGIN, SERVICE_RUN);
    expect(got).toMatchObject({ kind: "service", runId: SERVICE_RUN });
    reg.dispose();
  });

  it("is idempotent for a repeated registerService on the same key", () => {
    const reg = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    reg.registerService(PLUGIN, SERVICE_RUN);
    reg.registerService(PLUGIN, SERVICE_RUN);
    expect(reg.size()).toBe(1);
    reg.dispose();
  });

  it("exempts service entries from TTL expiry while sweeping orphaned dispatch entries", () => {
    let clock = 1_000;
    const reg = createPluginRunContextRegistry({
      ttlMs: 5_000,
      sweepIntervalMs: 60_000, // we drive expiry via get()'s inline guard + clock
      now: () => clock,
    });
    reg.register(PLUGIN, dispatchCtx(DISPATCH_RUN, clock));
    reg.registerService(PLUGIN, SERVICE_RUN);

    // Advance well past the dispatch TTL.
    clock += 10_000;

    // Dispatch entry is treated as expired (inline guard) and evicted.
    expect(reg.get(PLUGIN, DISPATCH_RUN)).toBeNull();
    // Service entry survives — never TTL-expired.
    expect(reg.get(PLUGIN, SERVICE_RUN)).toMatchObject({ kind: "service" });
    reg.dispose();
  });

  it("removes a service entry only on explicit deregister", () => {
    const reg = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    reg.registerService(PLUGIN, SERVICE_RUN);
    expect(reg.get(PLUGIN, SERVICE_RUN)).not.toBeNull();
    reg.deregister(PLUGIN, SERVICE_RUN);
    expect(reg.get(PLUGIN, SERVICE_RUN)).toBeNull();
    reg.dispose();
  });

  it("keeps dispatch and service entries isolated per (pluginDbId, runId)", () => {
    const reg = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    reg.register(PLUGIN, dispatchCtx(DISPATCH_RUN, Date.now()));
    reg.registerService(PLUGIN, SERVICE_RUN);

    expect(reg.get(PLUGIN, DISPATCH_RUN)).toMatchObject({ agentId: "agent-1" });
    expect(reg.get(PLUGIN, SERVICE_RUN)).toMatchObject({ kind: "service" });
    expect(reg.get("other-plugin", SERVICE_RUN)).toBeNull();
    reg.dispose();
  });

  // PLA-773: per-dispatch background entries carry the triggering company and,
  // unlike service entries, ARE TTL-swept (each dispatch is bounded).
  it("stores a background entry with the triggering company discriminated by kind", () => {
    const reg = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    reg.registerBackground(PLUGIN, BG_RUN, TRIGGER_COMPANY);

    expect(reg.get(PLUGIN, BG_RUN)).toMatchObject({
      kind: "background",
      runId: BG_RUN,
      companyId: TRIGGER_COMPANY,
    });
    reg.dispose();
  });

  it("is idempotent for a repeated registerBackground on the same key", () => {
    const reg = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    reg.registerBackground(PLUGIN, BG_RUN, TRIGGER_COMPANY);
    reg.registerBackground(PLUGIN, BG_RUN, TRIGGER_COMPANY);
    expect(reg.size()).toBe(1);
    reg.dispose();
  });

  it("TTL-sweeps a background entry (unlike a service entry)", () => {
    let clock = 1_000;
    const reg = createPluginRunContextRegistry({
      ttlMs: 5_000,
      sweepIntervalMs: 60_000,
      now: () => clock,
    });
    reg.registerBackground(PLUGIN, BG_RUN, TRIGGER_COMPANY);
    reg.registerService(PLUGIN, SERVICE_RUN);

    clock += 10_000;

    // Background entry is bounded — evicted by the inline TTL guard.
    expect(reg.get(PLUGIN, BG_RUN)).toBeNull();
    // Service entry survives — never TTL-expired.
    expect(reg.get(PLUGIN, SERVICE_RUN)).toMatchObject({ kind: "service" });
    reg.dispose();
  });

  it("removes a background entry on explicit deregister", () => {
    const reg = createPluginRunContextRegistry({ sweepIntervalMs: 60_000 });
    reg.registerBackground(PLUGIN, BG_RUN, TRIGGER_COMPANY);
    expect(reg.get(PLUGIN, BG_RUN)).not.toBeNull();
    reg.deregister(PLUGIN, BG_RUN);
    expect(reg.get(PLUGIN, BG_RUN)).toBeNull();
    reg.dispose();
  });
});
