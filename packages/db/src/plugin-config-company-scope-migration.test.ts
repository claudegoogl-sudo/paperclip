import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Exercises the fork-local amendment to migration 0164 (PLA-1833). The helper
// boots an already-migrated DB, so each case first rewinds plugin_config to its
// pre-0164 shape (no company_id, unique on plugin_id alone), seeds legacy
// instance-global rows, and replays the shipped 0164 statements the way
// applyPendingMigrationsManually does: one connection, in order.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin-config-company-scope migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MIGRATION_SQL = fs.readFileSync(
  new URL("./migrations/0164_plugin_config_company_scope.sql", import.meta.url),
  "utf8",
);

// 0185 derives company_secret_bindings from plugin_config, and on this instance
// both migrations are still pending, so it runs *against* the fanned-out table.
// The binding set is what the company-scoped resolver authorizes against, so it
// is replayed here too.
const BACKFILL_SQL = fs.readFileSync(
  new URL("./migrations/0185_backfill_plugin_secret_bindings.sql", import.meta.url),
  "utf8",
);

type Json = Parameters<ReturnType<typeof postgres>["json"]>[0];

function migrationStatements(migrationSql: string): string[] {
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

// One connection per migration, matching applyPendingMigrationsManually: the
// pg_temp helpers both migrations declare live and die with that session.
async function runMigrationSql(connectionString: string, migrationSql: string): Promise<void> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    for (const statement of migrationStatements(migrationSql)) {
      await sql.unsafe(statement);
    }
  } finally {
    await sql.end();
  }
}

async function runMigration(connectionString: string): Promise<void> {
  await runMigrationSql(connectionString, MIGRATION_SQL);
}

async function runBackfill(connectionString: string): Promise<void> {
  await runMigrationSql(connectionString, BACKFILL_SQL);
}

describeEmbeddedPostgres("0164 plugin_config company scope", () => {
  let connectionString: string;
  let cleanup: () => Promise<void>;
  let sql: ReturnType<typeof postgres>;

  // The live instance this migration has to survive has 8 companies; the
  // ambiguity that aborts upstream 0164 only appears with more than one.
  const companyIds = Array.from({ length: 8 }, () => randomUUID()).sort();

  beforeAll(async () => {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-pla1833-0164-");
    connectionString = db.connectionString;
    cleanup = db.cleanup;
    sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    for (const [index, id] of companyIds.entries()) {
      await sql`INSERT INTO companies (id, name, issue_prefix)
        VALUES (${id}, ${`Tenant ${index}`}, ${`P1833${index}`})`;
    }
  });

  afterAll(async () => {
    await sql?.end();
    await cleanup?.();
  });

  beforeEach(async () => {
    await sql`DELETE FROM company_secret_bindings`;
    await sql`DELETE FROM plugin_config`;
    await sql`DELETE FROM company_secrets`;
    await sql`DELETE FROM plugins`;
    await rewindToPre0164();
  });

  // Undo 0164's schema so the shipped statements can be replayed against the
  // legacy shape. Nothing else in the schema depends on plugin_config.company_id.
  async function rewindToPre0164(): Promise<void> {
    await sql`DROP INDEX IF EXISTS plugin_config_plugin_company_idx`;
    await sql`ALTER TABLE plugin_config
      DROP CONSTRAINT IF EXISTS plugin_config_company_id_companies_id_fk`;
    await sql`ALTER TABLE plugin_config DROP COLUMN IF EXISTS company_id`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS plugin_config_plugin_id_idx
      ON plugin_config USING btree (plugin_id)`;
  }

  async function insertPlugin(
    pluginKey: string,
    instanceConfigSchema?: Record<string, unknown>,
  ): Promise<string> {
    const id = randomUUID();
    const manifest: Record<string, unknown> = {
      id: pluginKey,
      name: pluginKey,
      version: "1.0.0",
      apiVersion: 1,
    };
    if (instanceConfigSchema) manifest.instanceConfigSchema = instanceConfigSchema;
    await sql`INSERT INTO plugins (id, plugin_key, package_name, version, manifest_json, status)
      VALUES (${id}, ${pluginKey}, ${`@test/${pluginKey}`}, '1.0.0', ${sql.json(manifest as Json)}, 'ready')`;
    return id;
  }

  // Mirrors the shape every shipped manifest uses: a string field tagged
  // `format: "secret-ref"`, here both at the top level and one level down.
  const SECRET_REF_SCHEMA = {
    type: "object",
    properties: {
      telegramBotTokenSecretId: { type: "string", format: "secret-ref" },
      supergroupId: { type: "number" },
      auth: {
        type: "object",
        properties: { tokenSecretId: { type: "string", format: "secret-ref" } },
      },
    },
  } as const;

  async function insertSecret(companyId: string): Promise<string> {
    const secretId = randomUUID();
    await sql`INSERT INTO company_secrets (id, company_id, key, name)
      VALUES (${secretId}, ${companyId}, ${`k-${secretId.slice(0, 8)}`}, 'test secret')`;
    return secretId;
  }

  async function configByCompany(pluginId: string): Promise<Map<string, Record<string, unknown>>> {
    const rows = (await sql`
      SELECT company_id, config_json FROM plugin_config WHERE plugin_id = ${pluginId}
    `) as unknown as { company_id: string; config_json: Record<string, unknown> }[];
    return new Map(rows.map((row) => [row.company_id, row.config_json]));
  }

  async function pluginBindings(): Promise<
    { company_id: string; secret_id: string; target_id: string; config_path: string }[]
  > {
    return (await sql`
      SELECT company_id, secret_id, target_id, config_path
      FROM company_secret_bindings
      WHERE target_type = 'plugin'
      ORDER BY company_id, target_id, config_path
    `) as unknown as {
      company_id: string;
      secret_id: string;
      target_id: string;
      config_path: string;
    }[];
  }

  // A pre-0164 row: one per plugin, no owning company.
  async function insertLegacyConfig(pluginId: string, config: unknown): Promise<void> {
    await sql`INSERT INTO plugin_config (plugin_id, config_json)
      VALUES (${pluginId}, ${sql.json(config as Json)})`;
  }

  async function bindSecret(pluginId: string, companyId: string): Promise<void> {
    const secretId = randomUUID();
    await sql`INSERT INTO company_secrets (id, company_id, key, name)
      VALUES (${secretId}, ${companyId}, ${`k-${secretId.slice(0, 8)}`}, 'test secret')`;
    await sql`INSERT INTO company_secret_bindings
      (company_id, secret_id, target_type, target_id, config_path, version_selector, required)
      VALUES (${companyId}, ${secretId}, 'plugin', ${pluginId}, ${`p-${secretId.slice(0, 8)}`}, 'latest', true)`;
  }

  async function configCompanyIds(pluginId: string): Promise<string[]> {
    const rows = (await sql`
      SELECT company_id FROM plugin_config WHERE plugin_id = ${pluginId} ORDER BY company_id
    `) as unknown as { company_id: string }[];
    return rows.map((row) => row.company_id);
  }

  it("fans a legacy row bound in two companies out to every company instead of aborting", async () => {
    // platform.cad on the live instance: bound in 2 of 8 companies, which
    // matches none of upstream's resolution passes.
    const pluginId = await insertPlugin("platform.cad");
    await insertLegacyConfig(pluginId, { githubPatSecretId: randomUUID() });
    await bindSecret(pluginId, companyIds[1]);
    await bindSecret(pluginId, companyIds[4]);

    await expect(runMigration(connectionString)).resolves.toBeUndefined();

    expect(await configCompanyIds(pluginId)).toEqual(companyIds);
  });

  it("fans a legacy row with a single binding out to every company, not just the binding owner", async () => {
    // paperclip-messenger: one binding (Platform) but a topicMap covering all 8
    // tenants. Upstream's unique-binding-owner pass would strand the other 7.
    const pluginId = await insertPlugin("paperclip-messenger");
    const topicMap = Object.fromEntries(companyIds.map((id, index) => [id, 100 + index]));
    await insertLegacyConfig(pluginId, { topicMap, supergroupId: -1001 });
    await bindSecret(pluginId, companyIds[0]);

    await runMigration(connectionString);

    expect(await configCompanyIds(pluginId)).toEqual(companyIds);
  });

  it("fans an unbound legacy row out to every company", async () => {
    const pluginId = await insertPlugin("platform.klipper");
    await insertLegacyConfig(pluginId, { moonrakerUrl: "http://printer.local" });

    await runMigration(connectionString);

    expect(await configCompanyIds(pluginId)).toEqual(companyIds);
  });

  it("copies config_json verbatim to every company", async () => {
    const pluginId = await insertPlugin("platform.vault");
    const config = { vaultUrl: "https://vault.local", tokenSecretId: randomUUID() };
    await insertLegacyConfig(pluginId, config);
    await bindSecret(pluginId, companyIds[0]);
    await bindSecret(pluginId, companyIds[3]);

    await runMigration(connectionString);

    const rows = (await sql`
      SELECT company_id, config_json FROM plugin_config WHERE plugin_id = ${pluginId}
    `) as unknown as { company_id: string; config_json: unknown }[];
    expect(rows).toHaveLength(companyIds.length);
    for (const row of rows) {
      expect(row.config_json).toEqual(config);
    }
  });

  it("leaves the resulting rows unique per (plugin, company)", async () => {
    const first = await insertPlugin("platform.cad");
    const second = await insertPlugin("platform.vault");
    await insertLegacyConfig(first, { a: 1 });
    await insertLegacyConfig(second, { b: 2 });
    await bindSecret(first, companyIds[2]);
    await bindSecret(first, companyIds[5]);

    await runMigration(connectionString);

    const [{ count }] = (await sql`
      SELECT count(*)::int AS count FROM plugin_config
    `) as unknown as { count: number }[];
    expect(count).toBe(2 * companyIds.length);
    // The unique index 0164 creates is the real guard; assert it exists so a
    // duplicate fan-out row could not have slipped through.
    const indexes = (await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'plugin_config' AND indexname = 'plugin_config_plugin_company_idx'
    `) as unknown as { indexname: string }[];
    expect(indexes).toHaveLength(1);
  });

  it("drops a foreign secret-ref from the copies and keeps it for the owning company", async () => {
    // paperclip-messenger on the live instance: telegramBotTokenSecretId names a
    // Platform-owned secret, but the topicMap covers all 8 tenants.
    const pluginId = await insertPlugin("paperclip-messenger", SECRET_REF_SCHEMA);
    const owner = companyIds[3];
    const secretId = await insertSecret(owner);
    const topicMap = Object.fromEntries(companyIds.map((id, index) => [id, 100 + index]));
    await insertLegacyConfig(pluginId, {
      telegramBotTokenSecretId: secretId,
      supergroupId: -1001,
      topicMap,
    });

    await runMigration(connectionString);

    const configs = await configByCompany(pluginId);
    expect([...configs.keys()].sort()).toEqual(companyIds);
    expect(configs.get(owner)).toEqual({
      telegramBotTokenSecretId: secretId,
      supergroupId: -1001,
      topicMap,
    });
    for (const companyId of companyIds.filter((id) => id !== owner)) {
      // Only the foreign ref goes; the map a global worker routes on stays whole.
      expect(configs.get(companyId)).toEqual({ supergroupId: -1001, topicMap });
    }
  });

  it("drops a nested foreign secret-ref without disturbing its siblings", async () => {
    const pluginId = await insertPlugin("platform.vault", SECRET_REF_SCHEMA);
    const owner = companyIds[6];
    const secretId = await insertSecret(owner);
    await insertLegacyConfig(pluginId, {
      auth: { tokenSecretId: secretId, mode: "token" },
      vaultUrl: "https://vault.local",
    });

    await runMigration(connectionString);

    const configs = await configByCompany(pluginId);
    expect(configs.get(owner)).toEqual({
      auth: { tokenSecretId: secretId, mode: "token" },
      vaultUrl: "https://vault.local",
    });
    for (const companyId of companyIds.filter((id) => id !== owner)) {
      expect(configs.get(companyId)).toEqual({
        auth: { mode: "token" },
        vaultUrl: "https://vault.local",
      });
    }
  });

  it("leaves values that are not resolvable secret refs alone on every row", async () => {
    // A UUID with no company_secrets row is a dangling pointer the fan-out
    // neither created nor can repair, and an unannotated UUID is not a ref at
    // all. Dropping either would be the migration editorialising.
    const pluginId = await insertPlugin("platform.cad", SECRET_REF_SCHEMA);
    const config = {
      telegramBotTokenSecretId: randomUUID(),
      githubPatSecretId: randomUUID(),
      supergroupId: 7,
    };
    await insertLegacyConfig(pluginId, config);

    await runMigration(connectionString);

    const configs = await configByCompany(pluginId);
    expect(configs.size).toBe(companyIds.length);
    for (const companyId of companyIds) {
      expect(configs.get(companyId)).toEqual(config);
    }
  });

  // The invariant the PLA-1841 security sign-off rests on: fan-out must not
  // change which companies end up holding a secret binding.
  it("derives exactly the owner-keyed bindings when 0185 backfills after the fan-out", async () => {
    const pluginId = await insertPlugin("paperclip-messenger", SECRET_REF_SCHEMA);
    const owner = companyIds[2];
    const secretId = await insertSecret(owner);
    await insertLegacyConfig(pluginId, { telegramBotTokenSecretId: secretId, supergroupId: -1 });

    await runMigration(connectionString);
    await runBackfill(connectionString);

    expect(await pluginBindings()).toEqual([
      {
        company_id: owner,
        secret_id: secretId,
        target_id: pluginId,
        config_path: "telegramBotTokenSecretId",
      },
    ]);
  });

  it("keeps the backfill owner-keyed even if every fanned-out row carries the ref", async () => {
    // Guards the derivation itself rather than the 0164 scrub: re-key 0185's
    // src=0 branch off plugin_config.company_id instead of company_secrets and
    // this becomes 8 bindings across 8 tenants.
    const pluginId = await insertPlugin("paperclip-messenger", SECRET_REF_SCHEMA);
    const owner = companyIds[5];
    const secretId = await insertSecret(owner);
    await insertLegacyConfig(pluginId, { telegramBotTokenSecretId: secretId });

    await runMigration(connectionString);
    await sql`UPDATE plugin_config
      SET config_json = jsonb_set(config_json, '{telegramBotTokenSecretId}', to_jsonb(${secretId}::text))
      WHERE plugin_id = ${pluginId}`;
    await runBackfill(connectionString);

    const bindings = await pluginBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.company_id).toBe(owner);
    expect(bindings.filter((binding) => binding.company_id !== owner)).toEqual([]);
  });

  it("still fails closed when there is no company to own the config", async () => {
    const pluginId = await insertPlugin("platform.cad");
    await insertLegacyConfig(pluginId, { a: 1 });
    await sql`DELETE FROM companies`;

    await expect(runMigration(connectionString)).rejects.toThrow(/Cannot assign company_id/);

    // Restore the tenants the rest of the suite shares.
    for (const [index, id] of companyIds.entries()) {
      await sql`INSERT INTO companies (id, name, issue_prefix)
        VALUES (${id}, ${`Tenant ${index}`}, ${`P1833${index}`})`;
    }
  });
});
