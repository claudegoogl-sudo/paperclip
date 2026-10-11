import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// plugin_config operator/tenant split, phase 1. Migration 0252 creates
// plugin_operator_config and copies operator-plane keys into it. It is
// additive: plugin_config must be byte-identical afterwards, and a re-run
// must be a no-op.

const MIGRATION_URL = new URL("./migrations/0252_plugin_operator_config.sql", import.meta.url);

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("0252 plugin_operator_config split (phase 1, additive)", () => {
  it(
    "copies only operator-plane keys, keeps plugin_config intact, and re-runs as a no-op",
    async () => {
      const db = await startEmbeddedPostgresTestDatabase("paperclip-db-operator-config-");
      cleanups.push(db.cleanup);
      await applyPendingMigrations(db.connectionString);
      const sql = postgres(db.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(() => sql.end({ timeout: 5 }));

      const [companyA, companyB, pluginId] = [randomUUID(), randomUUID(), randomUUID()];
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES
        (${companyA}, 'A', 'OPSA'), (${companyB}, 'B', 'OPSB')`;
      const manifest = {
        id: "test.split",
        instanceConfigSchema: {
          type: "object",
          properties: {
            companyPolicies: { type: "object" },
            displayLabel: { type: "string", "x-paperclip-scope": "tenant" },
          },
        },
      };
      await sql`INSERT INTO plugins (id, plugin_key, package_name, version, manifest_json, status)
        VALUES (${pluginId}, 'test.split', '@test/split', '1.0.0', ${sql.json(manifest)}, 'ready')`;
      const cfg = { companyPolicies: { a: 1 }, displayLabel: "x", undeclared: true };
      for (const companyId of [companyA, companyB]) {
        await sql`INSERT INTO plugin_config (plugin_id, company_id, config_json)
          VALUES (${pluginId}, ${companyId}, ${sql.json(cfg)})`;
      }
      const before = await sql`SELECT id, config_json::text AS c FROM plugin_config ORDER BY id`;

      const migrationSql = await readFile(MIGRATION_URL, "utf8");
      await sql.unsafe(migrationSql);

      const rows = await sql<{ config_json: Record<string, unknown> }[]>`
        SELECT config_json FROM plugin_operator_config WHERE plugin_id = ${pluginId}`;
      expect(rows).toHaveLength(1);
      // Undeclared keys are operator-plane (fail-closed); the tenant key is not copied.
      expect(rows[0].config_json).toEqual({ companyPolicies: { a: 1 }, undeclared: true });

      const after = await sql`SELECT id, config_json::text AS c FROM plugin_config ORDER BY id`;
      expect(after).toEqual(before);

      // Re-run converges: still one row, unchanged.
      await sql.unsafe(migrationSql);
      const rerun = await sql`SELECT config_json FROM plugin_operator_config WHERE plugin_id = ${pluginId}`;
      expect(rerun).toHaveLength(1);
      expect(rerun[0].config_json).toEqual({ companyPolicies: { a: 1 }, undeclared: true });
    },
    120_000,
  );
});
