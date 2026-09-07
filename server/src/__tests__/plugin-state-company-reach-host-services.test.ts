import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  pluginCompanySettings,
  pluginState,
  plugins,
} from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as any;
}

const PLUGIN_KEY = "paperclip.messenger";

/**
 * Regression suite for the company-scoped plugin state reach check
 * (`requireStateCompanyReach` in plugin-host-services).
 *
 * Company-scoped `state.get` / `state.set` / `state.delete` are admitted under
 * the bare worker-lifetime `serviceScope` (SDK allowlist
 * `SERVICE_SCOPE_COMPANY_METHODS`) with a worker-chosen companyId and no
 * dispatch to pin a tenant. The allowlist invariant requires a compensating
 * server-side per-company reach check: an idle worker must not be able to
 * pre-poison an unprovisioned company's state before adoption, or read/wipe
 * partitions of companies it does not serve.
 */

/** Host-side call shape: the RPC `params` record carries `value` inside. */
type HostStateCaller = ReturnType<typeof buildHostServices>["state"];
const callState = <K extends "get" | "set" | "delete">(
  surface: HostStateCaller,
  method: K,
  params: Record<string, unknown>,
): Promise<unknown> =>
  (surface[method] as unknown as (p: Record<string, unknown>) => Promise<unknown>)(params);

describeEmbeddedPostgres("plugin company-scoped state reach check", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-state-reach-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginState);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix: string) {
    return db
      .insert(companies)
      .values({
        name: `${prefix} ${randomUUID()}`,
        issuePrefix: `${prefix}${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function installPlugin(status: "ready" | "uninstalled" | "disabled" = "ready") {
    return db
      .insert(plugins)
      .values({
        pluginKey: PLUGIN_KEY,
        packageName: "@paperclipai/plugin-messenger",
        version: "0.1.0",
        manifestJson: { id: PLUGIN_KEY } as any,
        status,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("serves company-scoped state for a provisioned company (dispatch-parity happy path)", async () => {
    const company = await createCompany("STA");
    const plugin = await installPlugin();
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await callState(services.state, "set", {
      scopeKind: "company",
      scopeId: company.id,
      stateKey: "poll-offset",
      value: { offset: 42 },
    });
    await expect(
      callState(services.state, "get", {
        scopeKind: "company",
        scopeId: company.id,
        stateKey: "poll-offset",
      }),
    ).resolves.toEqual({ offset: 42 });

    await callState(services.state, "delete", {
      scopeKind: "company",
      scopeId: company.id,
      stateKey: "poll-offset",
    });
    await expect(
      callState(services.state, "get", {
        scopeKind: "company",
        scopeId: company.id,
        stateKey: "poll-offset",
      }),
    ).resolves.toBeNull();

    services.dispose();
  });

  it("denies state.set for an unprovisioned company and writes nothing (BOLA regression)", async () => {
    const company = await createCompany("STA");
    const plugin = await installPlugin("uninstalled");
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await expect(
      callState(services.state, "set", {
        scopeKind: "company",
        scopeId: company.id,
        stateKey: "k",
        value: { poison: true },
      }),
    ).rejects.toThrow();

    const rows = await db.select().from(pluginState);
    expect(rows).toHaveLength(0);

    services.dispose();
  });

  it("denies state.get and state.delete for an unprovisioned company (BOLA regression)", async () => {
    const company = await createCompany("STA");
    const plugin = await installPlugin("uninstalled");
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await expect(
      callState(services.state, "get", {
        scopeKind: "company",
        scopeId: company.id,
        stateKey: "k",
      }),
    ).rejects.toThrow();
    await expect(
      callState(services.state, "delete", {
        scopeKind: "company",
        scopeId: company.id,
        stateKey: "k",
      }),
    ).rejects.toThrow();

    services.dispose();
  });

  it("denies company-scoped state when the company explicitly disabled the plugin", async () => {
    const company = await createCompany("STA");
    const plugin = await installPlugin();
    await db.insert(pluginCompanySettings).values({
      companyId: company.id,
      pluginId: plugin.id,
      enabled: false,
    });
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    for (const method of ["get", "set", "delete"] as const) {
      await expect(
        callState(services.state, method, {
          scopeKind: "company",
          scopeId: company.id,
          stateKey: "k",
          value: 1,
        }),
      ).rejects.toThrow("disabled");
    }

    services.dispose();
  });

  it("denies company-scoped state for an unknown company", async () => {
    const plugin = await installPlugin();
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await expect(
      callState(services.state, "get", {
        scopeKind: "company",
        scopeId: randomUUID(),
        stateKey: "k",
      }),
    ).rejects.toThrow("Company not found");

    services.dispose();
  });

  it("rejects scopeKind:company with a missing/empty scopeId instead of keying the NULL partition", async () => {
    const plugin = await installPlugin();
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await expect(
      callState(services.state, "set", {
        scopeKind: "company",
        scopeId: "",
        stateKey: "k",
        value: 1,
      }),
    ).rejects.toThrow();
    await expect(
      callState(services.state, "set", {
        scopeKind: "company",
        stateKey: "k",
        value: 1,
      }),
    ).rejects.toThrow();

    const rows = await db.select().from(pluginState);
    expect(rows).toHaveLength(0);

    services.dispose();
  });

  it("leaves non-company scopes ungated (instance-scope parity)", async () => {
    const plugin = await installPlugin();
    const services = buildHostServices(db, plugin.id, PLUGIN_KEY, createEventBusStub());

    await callState(services.state, "set", {
      scopeKind: "instance",
      stateKey: "boot-count",
      value: { n: 1 },
    });
    await expect(
      callState(services.state, "get", { scopeKind: "instance", stateKey: "boot-count" }),
    ).resolves.toEqual({ n: 1 });

    services.dispose();
  });
});
