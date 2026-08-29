/**
 * Plugin config-key egress allowlist enforced at the `ctx.http.fetch`
 * chokepoint (`plugin-host-services.ts`, via `enforcePluginConfigEgress`).
 *
 * Pins the operator amendments at the decision layer, against a real
 * DB:
 *   A2  the deny decision is PLUGIN-WIDE (union across every company's row),
 *       NOT per-tenant — enforcing for one company denies for every company.
 *   A3  a plugin's own declared config value is ALWAYS part of the effective
 *       allowlist; enforcement only gates destinations OUTSIDE that value.
 *   —   log-only (not enforced): a non-allowlisted destination is still
 *       allowed, and exactly one would-deny observation is recorded.
 *   —   enforcing: a non-allowlisted destination is hard-denied
 *       (PluginConfigEgressDeniedError) before any dispatch; an allowlisted
 *       one still flows.
 *   —   a plugin with no `format:"uri"` config keys is never gated by this
 *       mechanism (unconditional allow, no observation).
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  plugins,
  pluginCompanySettings,
  pluginConfigEgressAllowlist,
  pluginConfigEgressWouldDenyObservations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  PluginConfigEgressDeniedError,
  decidePluginConfigEgress,
  enforcePluginConfigEgress,
} from "../services/plugin-config-egress.js";
import { listPluginConfigEgressWouldDeny } from "../services/plugin-config-egress-harvest.js";
import { parseExecutionPolicyBootstrapEnv } from "../services/execution-policy-bootstrap.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping plugin config-egress chokepoint tests: ${support.reason ?? "unsupported environment"}`);
}

const MOONRAKER_MANIFEST = {
  id: "test.klipper",
  name: "Klipper (test)",
  version: "0.0.1",
  instanceConfigSchema: {
    type: "object",
    properties: {
      moonrakerBaseUrl: { type: "string", format: "uri" },
    },
  },
} as const;

describeDb("plugin config-egress chokepoint", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-config-egress-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(pluginConfigEgressAllowlist);
    await db.delete(pluginConfigEgressWouldDenyObservations);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin(): Promise<string> {
    const id = randomUUID();
    await db.insert(plugins).values({
      id,
      pluginKey: `test.klipper.${id.slice(0, 8)}`,
      packageName: "@test/klipper",
      version: "0.0.1",
      manifestJson: MOONRAKER_MANIFEST as never,
    });
    return id;
  }

  /** Poll the harvest table until its total observation count reaches `minCount` (fire-and-forget write — see plugin-config-egress.ts). */
  async function waitForWouldDenyCount(pluginId: string, minCount: number, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await listPluginConfigEgressWouldDeny(db, { pluginId });
      const total = rows.reduce((sum, row) => sum + row.count, 0);
      if (total >= minCount || Date.now() >= deadline) return rows;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function seedCompanyWithConfig(pluginId: string, prefix: string, moonrakerBaseUrl: string): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `co-${prefix}`, issuePrefix: prefix.toUpperCase().slice(0, 6) });
    await db.insert(pluginCompanySettings).values({
      companyId,
      pluginId,
      enabled: true,
      settingsJson: { moonrakerBaseUrl },
    });
    return companyId;
  }

  it("plugin with no format:uri config keys is unconditionally allowed, no observation", async () => {
    const id = randomUUID();
    await db.insert(plugins).values({
      id,
      pluginKey: `test.no-uri.${id.slice(0, 8)}`,
      packageName: "@test/no-uri",
      version: "0.0.1",
      manifestJson: { id: "test.no-uri", name: "No URI", version: "0.0.1" } as never,
    });

    await expect(enforcePluginConfigEgress(db, id, "https://attacker.example")).resolves.toBeUndefined();
    const suggestions = await listPluginConfigEgressWouldDeny(db, { pluginId: id });
    expect(suggestions).toHaveLength(0);
  });

  it("log-only (default posture): non-allowlisted destination still dispatches, records exactly one would-deny observation", async () => {
    const pluginId = await seedPlugin();
    await seedCompanyWithConfig(pluginId, "aaa", "http://printer-a.local:7125");
    // No plugin_config_egress_allowlist row at all — matches the A3 backfill
    // posture (born log-only) as well as a brand-new instance that has never
    // been reviewed.

    await expect(enforcePluginConfigEgress(db, pluginId, "https://attacker.example/steal")).resolves.toBeUndefined();
    await expect(enforcePluginConfigEgress(db, pluginId, "https://attacker.example/steal-again")).resolves.toBeUndefined();

    // The harvest write is deliberately fire-and-forget (must never block the
    // fetch it rides on) — poll rather than assume it's landed the instant
    // enforcePluginConfigEgress resolves.
    const suggestions = await waitForWouldDenyCount(pluginId, 2);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].origin).toBe("https://attacker.example");
    expect(suggestions[0].count).toBe(2);
  });

  it("the plugin's own declared config value is always allowed, log-only or enforcing", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompanyWithConfig(pluginId, "bbb", "http://printer-b.local:7125");
    await db.insert(pluginConfigEgressAllowlist).values({
      companyId,
      pluginId,
      configKey: "moonrakerBaseUrl",
      allowedEgress: [],
      egressAllowlistEnforced: true,
    });

    await expect(
      enforcePluginConfigEgress(db, pluginId, "http://printer-b.local:7125/printer/info"),
    ).resolves.toBeUndefined();
  });

  it("A2 — enforcing ONE company's row denies for the WHOLE PLUGIN, including other companies' fetches", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompanyWithConfig(pluginId, "ccc", "http://printer-a.local:7125");
    const companyB = await seedCompanyWithConfig(pluginId, "ddd", "http://printer-b.local:7125");
    // Only company A's row is flipped to enforcing.
    await db.insert(pluginConfigEgressAllowlist).values({
      companyId: companyA,
      pluginId,
      configKey: "moonrakerBaseUrl",
      allowedEgress: [],
      egressAllowlistEnforced: true,
    });

    // A destination that is neither company's declared config value is denied
    // — there is no per-call company context on this path (A2), so this
    // proves the union+OR semantics rather than a per-tenant check.
    await expect(enforcePluginConfigEgress(db, pluginId, "https://attacker.example")).rejects.toThrow(
      PluginConfigEgressDeniedError,
    );

    // Company B's OWN declared origin is still allowed — it's unconditionally
    // part of the union allowlist even though B's own row is still log-only.
    await expect(
      enforcePluginConfigEgress(db, pluginId, "http://printer-b.local:7125/printer/info"),
    ).resolves.toBeUndefined();
  });

  it("upstream task-scoped egress grant (K8s bootstrap allow-FQDNs) does not bypass the plugin-config egress allowlist", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompanyWithConfig(pluginId, "egr", "http://printer-grant.local:7125");
    await db.insert(pluginConfigEgressAllowlist).values({
      companyId,
      pluginId,
      configKey: "moonrakerBaseUrl",
      allowedEgress: [],
      egressAllowlistEnforced: true,
    });

    // The upstream runtime-layer grant is REAL: the execution-policy
    // bootstrap turns the task-scoped egress grant env into K8s network
    // allowances for confined runs (upstream 817 task-scoped egress grants).
    const bootstrap = parseExecutionPolicyBootstrapEnv({
      PAPERCLIP_EXECUTION_MODE: "kubernetes",
      PAPERCLIP_K8S_EGRESS_MODE: "standard",
      PAPERCLIP_K8S_EGRESS_ALLOW_FQDNS: "attacker.example",
    });
    expect(bootstrap?.kubernetesConfig.egressAllowFqdns).toContain("attacker.example");

    // …and the fork's host-side plugin-config egress gate never consults
    // it: a destination outside the config-derived union allowlist is
    // denied even though the run carries the matching network-layer grant.
    await expect(enforcePluginConfigEgress(db, pluginId, "https://attacker.example/steal")).rejects.toThrow(
      PluginConfigEgressDeniedError,
    );
  });

  it("decidePluginConfigEgress reports wouldDeny only when not enforced, and allow=false only when enforced", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompanyWithConfig(pluginId, "eee", "http://printer-e.local:7125");

    const logOnly = await decidePluginConfigEgress(db, pluginId, "https://attacker.example");
    expect(logOnly.allow).toBe(true);
    expect(logOnly.wouldDeny).toBe(true);

    await db.insert(pluginConfigEgressAllowlist).values({
      companyId,
      pluginId,
      configKey: "moonrakerBaseUrl",
      allowedEgress: [],
      egressAllowlistEnforced: true,
    });

    const enforced = await decidePluginConfigEgress(db, pluginId, "https://attacker.example");
    expect(enforced.allow).toBe(false);
    expect(enforced.wouldDeny).toBe(false);
  });

  it("an operator-added allowlist extra is honored once enforcing", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompanyWithConfig(pluginId, "fff", "http://printer-f.local:7125");
    await db.insert(pluginConfigEgressAllowlist).values({
      companyId,
      pluginId,
      configKey: "moonrakerBaseUrl",
      allowedEgress: ["https://secondary-printer.example"],
      egressAllowlistEnforced: true,
    });

    await expect(
      enforcePluginConfigEgress(db, pluginId, "https://secondary-printer.example/status"),
    ).resolves.toBeUndefined();
    await expect(enforcePluginConfigEgress(db, pluginId, "https://attacker.example")).rejects.toThrow(
      PluginConfigEgressDeniedError,
    );
  });

  it("fails closed on an undeterminable destination while enforcing", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompanyWithConfig(pluginId, "ggg", "http://printer-g.local:7125");
    await db.insert(pluginConfigEgressAllowlist).values({
      companyId,
      pluginId,
      configKey: "moonrakerBaseUrl",
      allowedEgress: [],
      egressAllowlistEnforced: true,
    });

    await expect(enforcePluginConfigEgress(db, pluginId, "not-a-url")).rejects.toThrow(PluginConfigEgressDeniedError);
  });
});
