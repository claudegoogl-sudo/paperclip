import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Exercises migration 0104_backfill_plugin_secret_bindings against representative
// pre-state data. The embedded-pg helper boots an already-migrated DB (so 0104 has
// run once over empty data); each case seeds plugin/secret/config rows and then
// replays the shipped backfill SQL on a fresh connection — mirroring how
// applyPendingMigrationsManually executes it (one connection so the pg_temp helper
// survives between the two statements).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping backfill-plugin-secret-bindings tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const BACKFILL_SQL = fs.readFileSync(
  new URL("./migrations/0104_backfill_plugin_secret_bindings.sql", import.meta.url),
  "utf8",
);

type Json = Parameters<ReturnType<typeof postgres>["json"]>[0];

function backfillStatements(): string[] {
  return BACKFILL_SQL.split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

// Run the shipped backfill exactly as the migrator would: one connection, each
// statement in order, so the session-temp helper function persists between them.
async function runBackfill(connectionString: string): Promise<void> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    for (const statement of backfillStatements()) {
      await sql.unsafe(statement);
    }
  } finally {
    await sql.end();
  }
}

describeEmbeddedPostgres("0100 backfill company_secret_bindings", () => {
  let connectionString: string;
  let cleanup: () => Promise<void>;
  let sql: ReturnType<typeof postgres>;

  // Stable tenants reused across cases (company_secrets.company_id keys the binding).
  const companyA = randomUUID();
  const companyB = randomUUID();

  beforeAll(async () => {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-pla660-backfill-");
    connectionString = db.connectionString;
    cleanup = db.cleanup;
    sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES
      (${companyA}, 'Tenant A', ${"PLA660A"}),
      (${companyB}, 'Tenant B', ${"PLA660B"})`;
  });

  afterAll(async () => {
    await sql?.end();
    await cleanup?.();
  });

  beforeEach(async () => {
    // Wipe the per-case fixtures; tenants (companies) persist.
    await sql`DELETE FROM company_secret_bindings`;
    await sql`DELETE FROM plugin_config`;
    await sql`DELETE FROM plugin_company_settings`;
    await sql`DELETE FROM company_secrets`;
    await sql`DELETE FROM plugins`;
  });

  // --- fixture helpers -----------------------------------------------------

  async function insertPlugin(instanceConfigSchema: unknown): Promise<string> {
    const id = randomUUID();
    const key = `platform.test-${id.slice(0, 8)}`;
    const manifest = {
      id: key,
      name: key,
      version: "1.0.0",
      apiVersion: 1,
      ...(instanceConfigSchema === undefined ? {} : { instanceConfigSchema }),
    };
    await sql`INSERT INTO plugins (id, plugin_key, package_name, version, manifest_json, status)
      VALUES (${id}, ${key}, ${`@test/${key}`}, '1.0.0', ${sql.json(manifest as Json)}, 'ready')`;
    return id;
  }

  async function insertSecret(companyId: string, name: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO company_secrets (id, company_id, key, name)
      VALUES (${id}, ${companyId}, ${name}, ${name})`;
    return id;
  }

  async function setInstanceConfig(pluginId: string, config: unknown): Promise<void> {
    await sql`INSERT INTO plugin_config (plugin_id, config_json)
      VALUES (${pluginId}, ${sql.json(config as Json)})`;
  }

  async function setCompanySettings(
    companyId: string,
    pluginId: string,
    settings: unknown,
  ): Promise<void> {
    await sql`INSERT INTO plugin_company_settings (company_id, plugin_id, settings_json)
      VALUES (${companyId}, ${pluginId}, ${sql.json(settings as Json)})`;
  }

  type Binding = {
    company_id: string;
    secret_id: string;
    target_type: string;
    target_id: string;
    config_path: string;
    version_selector: string;
    required: boolean;
    label: string | null;
  };

  async function listBindings(): Promise<Binding[]> {
    return (await sql`
      SELECT company_id, secret_id, target_type, target_id, config_path,
             version_selector, required, label
      FROM company_secret_bindings
      ORDER BY company_id, config_path
    `) as unknown as Binding[];
  }

  const SECRET_REF_SCHEMA = {
    type: "object",
    properties: {
      githubPatSecretId: { type: "string", format: "secret-ref" },
      artifactRepoUrl: { type: "string" },
    },
  };

  // --- cases ---------------------------------------------------------------

  it("creates an instance-wide binding keyed to the secret owner with target_id = plugins.id", async () => {
    const pluginId = await insertPlugin(SECRET_REF_SCHEMA);
    const secretId = await insertSecret(companyA, "cad-pat");
    await setInstanceConfig(pluginId, { githubPatSecretId: secretId, artifactRepoUrl: "https://x" });

    await runBackfill(connectionString);

    const bindings = await listBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      company_id: companyA,
      secret_id: secretId,
      target_type: "plugin",
      target_id: pluginId, // plugins.id, NOT the plugin key
      config_path: "githubPatSecretId",
      version_selector: "latest",
      required: true,
      label: "backfill PLA-660",
    });
  });

  it("creates per-company bindings from plugin_company_settings.settings_json", async () => {
    const pluginId = await insertPlugin({
      type: "object",
      properties: { apiKeyRef: { type: "string", format: "secret-ref" } },
    });
    const secretA = await insertSecret(companyA, "key-a");
    const secretB = await insertSecret(companyB, "key-b");
    await setCompanySettings(companyA, pluginId, { apiKeyRef: secretA });
    await setCompanySettings(companyB, pluginId, { apiKeyRef: secretB });

    await runBackfill(connectionString);

    const bindings = await listBindings();
    expect(bindings).toHaveLength(2);
    expect(bindings.find((b) => b.company_id === companyA)).toMatchObject({
      secret_id: secretA,
      target_id: pluginId,
      config_path: "apiKeyRef",
    });
    expect(bindings.find((b) => b.company_id === companyB)).toMatchObject({
      secret_id: secretB,
      target_id: pluginId,
      config_path: "apiKeyRef",
    });
  });

  it("drops a per-company ref to another company's secret, keeps the owner-matched one", async () => {
    // Company A's per-company settings reference A's OWN secret and (at a second
    // secret-ref path) company B's secret UUID. The owner-match constraint keeps the
    // A->A binding and drops the A->B one. On the pre-PLA-665 SQL the cross-owner ref
    // fabricated a binding(company_id=B) that B never authored; this case fails there.
    const pluginId = await insertPlugin({
      type: "object",
      properties: {
        ownRef: { type: "string", format: "secret-ref" },
        foreignRef: { type: "string", format: "secret-ref" },
      },
    });
    const secretA = await insertSecret(companyA, "key-a");
    const secretB = await insertSecret(companyB, "key-b");
    await setCompanySettings(companyA, pluginId, { ownRef: secretA, foreignRef: secretB });

    await runBackfill(connectionString);

    const bindings = await listBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      company_id: companyA,
      secret_id: secretA,
      target_id: pluginId,
      config_path: "ownRef",
    });
    // The cross-owner ref must NOT fabricate a binding for B (or anyone).
    expect(bindings.some((b) => b.secret_id === secretB)).toBe(false);
  });

  it("is idempotent: a second run inserts nothing", async () => {
    const pluginId = await insertPlugin(SECRET_REF_SCHEMA);
    const secretId = await insertSecret(companyA, "cad-pat");
    await setInstanceConfig(pluginId, { githubPatSecretId: secretId });

    await runBackfill(connectionString);
    const first = await listBindings();
    await runBackfill(connectionString);
    const second = await listBindings();

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("never clobbers a pre-existing binding with a different secret_id at the same key", async () => {
    const pluginId = await insertPlugin(SECRET_REF_SCHEMA);
    const backfillSecret = await insertSecret(companyA, "cad-pat");
    const operatorSecret = await insertSecret(companyA, "operator-pat");
    await setInstanceConfig(pluginId, { githubPatSecretId: backfillSecret });

    // Operator/DPR-set row already present at the unique key (different secret).
    await sql`INSERT INTO company_secret_bindings
      (company_id, secret_id, target_type, target_id, config_path, label)
      VALUES (${companyA}, ${operatorSecret}, 'plugin', ${pluginId}, 'githubPatSecretId', 'operator-set')`;

    await runBackfill(connectionString);

    const bindings = await listBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secret_id: operatorSecret, // preserved, NOT overwritten by backfillSecret
      label: "operator-set",
    });
  });

  it("skips an orphan ref (UUID with no company_secrets row) without throwing", async () => {
    const pluginId = await insertPlugin(SECRET_REF_SCHEMA);
    await setInstanceConfig(pluginId, { githubPatSecretId: randomUUID() });

    await expect(runBackfill(connectionString)).resolves.toBeUndefined();
    expect(await listBindings()).toHaveLength(0);
  });

  it("creates no bindings for a plugin with no secret-ref manifest fields", async () => {
    const pluginId = await insertPlugin({
      type: "object",
      properties: {
        artifactRepoUrl: { type: "string" },
        // A UUID-shaped value that is NOT annotated secret-ref must be ignored
        // (we do not replicate the collect-all-UUID fallback).
        someId: { type: "string" },
      },
    });
    const secretId = await insertSecret(companyA, "unrelated");
    await setInstanceConfig(pluginId, { artifactRepoUrl: "https://x", someId: secretId });

    await runBackfill(connectionString);

    expect(await listBindings()).toHaveLength(0);
  });

  it("detects nested and combinator-wrapped secret-ref paths (generality over all plugins)", async () => {
    const pluginId = await insertPlugin({
      type: "object",
      allOf: [
        {
          properties: {
            db: {
              type: "object",
              properties: { passwordRef: { type: "string", format: "secret-ref" } },
            },
          },
        },
      ],
    });
    const secretId = await insertSecret(companyA, "db-pw");
    await setInstanceConfig(pluginId, { db: { passwordRef: secretId } });

    await runBackfill(connectionString);

    const bindings = await listBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      company_id: companyA,
      secret_id: secretId,
      config_path: "db.passwordRef",
    });
  });
});
