import { describe, expect, it } from "vitest";
import { checkToolGrant, toolRequiresGrant, type GrantLookup } from "./plugin-tool-grants.js";

const C = "c1", A = "agent-a", B = "agent-b";
const CAD = "platform.cad:cad.run_script";
type Row = { id: string; companyId: string; agentId: string; toolKey: string; expiresAt: Date };
// Mirrors the SQL: exact equality on all three keys AND expires_at > now.
const mk = (rows: Row[]): GrantLookup => async (q) =>
  rows.find((r) => r.companyId === q.companyId && r.agentId === q.agentId && r.toolKey === q.toolKey && r.expiresAt > q.now) ?? null;
const now = new Date("2026-11-10T12:00:00Z");
const future = new Date("2026-12-10T00:00:00Z");
const run = (rows: Row[], tool: string, agentId = A, companyId = C) =>
  checkToolGrant({ lookup: mk(rows), companyId, agentId, namespacedTool: tool, now });

describe("plugin tool grants", () => {
  const g = (over: Partial<Row> = {}): Row => ({ id: "g1", companyId: C, agentId: A, toolKey: CAD, expiresAt: future, ...over });
  it("no grant -> deny", async () => expect(await run([], CAD)).toMatchObject({ allowed: false, reason: "no_grant" }));
  it("expired -> deny", async () => expect(await run([g({ expiresAt: new Date("2026-11-01T00:00:00Z") })], CAD)).toMatchObject({ allowed: false }));
  it("exact grant -> allow", async () => expect(await run([g()], CAD)).toMatchObject({ allowed: true, grantId: "g1" }));
  it("prefix/glob/bare grant -> deny", async () => {
    for (const k of ["platform.cad:*", "platform.cad:cad", "cad.run_script", "platform.cad:cad.run_scrip"])
      expect(await run([g({ toolKey: k })], CAD)).toMatchObject({ allowed: false });
  });
  it("other agent / other company -> deny", async () => {
    expect(await run([g()], CAD, B)).toMatchObject({ allowed: false });
    expect(await run([g()], CAD, A, "c2")).toMatchObject({ allowed: false });
  });
  it("lookup error -> deny (fail closed)", async () => {
    const r = await checkToolGrant({ lookup: async () => { throw new Error("db"); }, companyId: C, agentId: A, namespacedTool: CAD });
    expect(r).toMatchObject({ allowed: false, reason: "lookup_error" });
  });
  it("tool without requiresGrant unchanged", async () => {
    expect(toolRequiresGrant("platform.klipper:klipper.get_printer_status")).toBe(false);
    expect(await run([], "platform.klipper:klipper.get_printer_status", B)).toEqual({ allowed: true, required: false });
  });
  it("all vault tools require grant", () => {
    expect(toolRequiresGrant("platform.vault:vault.read")).toBe(true);
    expect(toolRequiresGrant("platform.vault:vault.future")).toBe(true);
  });
});
