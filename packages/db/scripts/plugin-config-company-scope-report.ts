// Pre-upgrade dry run for migration 0164_plugin_config_company_scope (PLA-1833).
//
// 0164 turns instance-global plugin_config rows into per-company rows by fanning
// each legacy row out to every company. This script reports exactly which rows
// it will write, without touching the database, so an operator can review the
// plan before running `paperclipai migrate`.
//
// Usage:
//   pnpm db:plugin-config-report [postgres://...]
//
// Connection string resolution: first positional arg > DATABASE_URL > the
// instance config's external connection string > its embedded Postgres port.
//
// Read-only and safe to re-run. Exit codes: 0 report produced (or already
// migrated), 1 the migration would fail, 2 could not connect or inspect.

import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { resolvePaperclipConfigPathForInstance } from "@paperclipai/shared/home-paths";

const DEFAULT_EMBEDDED_PORT = 54329;

type PartialConfig = {
  database?: {
    mode?: "embedded-postgres" | "postgres";
    connectionString?: string;
    embeddedPostgresPort?: number;
  };
};

function readConfig(configPath: string): PartialConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return typeof parsed === "object" && parsed ? (parsed as PartialConfig) : null;
  } catch {
    return null;
  }
}

function resolveConnectionString(): { connectionString: string; source: string } {
  const fromArgv = process.argv[2]?.trim();
  if (fromArgv) return { connectionString: fromArgv, source: "command-line argument" };

  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return { connectionString: fromEnv, source: "DATABASE_URL" };

  const configPath = resolvePaperclipConfigPathForInstance();
  const database = readConfig(configPath)?.database ?? {};
  if (database.mode === "postgres" && typeof database.connectionString === "string") {
    const trimmed = database.connectionString.trim();
    if (trimmed) return { connectionString: trimmed, source: configPath };
  }
  const port = Number.isInteger(database.embeddedPostgresPort)
    ? (database.embeddedPostgresPort as number)
    : DEFAULT_EMBEDDED_PORT;
  return {
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `${configPath} (embedded, port ${port})`,
  };
}

// config_json holds secret-ref UUIDs rather than secret material, but this
// report is an operator artifact that tends to get pasted into tickets, so
// summarise the shape instead of dumping values.
function describeConfig(configJson: unknown): string {
  if (!configJson || typeof configJson !== "object") return "<empty>";
  const keys = Object.keys(configJson as Record<string, unknown>);
  if (keys.length === 0) return "<empty>";
  return `${keys.length} key(s): ${keys.sort().join(", ")}`;
}

// Same rule as 0164's pg_temp.pla1843_collect_secret_ref_paths and the server's
// collectSecretRefPaths: only a property the manifest tags `format: "secret-ref"`.
function collectSecretRefPaths(schema: unknown, prefix = ""): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const node = schema as Record<string, unknown>;
  const paths: string[] = [];

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) paths.push(...collectSecretRefPaths(branch, prefix));
  }

  const properties = node.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [key, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
      if (!propertySchema || typeof propertySchema !== "object" || Array.isArray(propertySchema)) {
        continue;
      }
      const path = prefix ? `${prefix}.${key}` : key;
      if ((propertySchema as Record<string, unknown>).format === "secret-ref") paths.push(path);
      paths.push(...collectSecretRefPaths(propertySchema, path));
    }
  }

  return paths;
}

function readSecretRefAtPath(configJson: unknown, dotPath: string): string | null {
  let current: unknown = configJson;
  for (const key of dotPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === "string") return current;
  if (current && typeof current === "object" && !Array.isArray(current)) {
    const record = current as Record<string, unknown>;
    if (record.type === "secret_ref" && typeof record.secretId === "string") return record.secretId;
  }
  return null;
}

async function main(): Promise<number> {
  const { connectionString, source } = resolveConnectionString();
  console.log("Migration 0164 plugin_config fan-out plan");
  console.log(`Database: resolved from ${source}`);

  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    const [scoped] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'plugin_config'
          AND column_name = 'company_id'
      ) AS exists
    `;
    if (scoped?.exists) {
      const rows = await sql<{ plugin_key: string | null; row_count: number }[]>`
        SELECT p.plugin_key, count(*)::int AS row_count
        FROM plugin_config pc
        LEFT JOIN plugins p ON p.id = pc.plugin_id
        GROUP BY p.plugin_key
        ORDER BY p.plugin_key
      `;
      console.log("\nMigration 0164 has already been applied; nothing to plan.");
      for (const row of rows) {
        console.log(`  ${row.plugin_key ?? "<orphan plugin>"}: ${row.row_count} company row(s)`);
      }
      return 0;
    }

    const companies = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM companies ORDER BY id::text
    `;
    const legacyRows = await sql<
      {
        plugin_key: string | null;
        config_json: unknown;
        manifest_json: unknown;
        binding_companies: number;
      }[]
    >`
      SELECT
        p.plugin_key,
        pc.config_json,
        p.manifest_json,
        (
          SELECT count(DISTINCT csb.company_id)::int
          FROM company_secret_bindings csb
          WHERE csb.target_type = 'plugin' AND csb.target_id = pc.plugin_id::text
        ) AS binding_companies
      FROM plugin_config pc
      LEFT JOIN plugins p ON p.id = pc.plugin_id
      ORDER BY p.plugin_key
    `;
    const secretOwners = new Map(
      (
        await sql<{ id: string; company_id: string }[]>`
          SELECT id, company_id FROM company_secrets
        `
      ).map((secret) => [secret.id.toLowerCase(), secret.company_id]),
    );

    const primaryCompanyId = companies[0]?.id;
    console.log(`\nCompanies: ${companies.length}`);
    for (const company of companies) {
      const marker = company.id === primaryCompanyId ? "  <- primary, keeps the original row" : "";
      console.log(`  ${company.id}  ${company.name}${marker}`);
    }

    const companyNamesById = new Map(companies.map((company) => [company.id, company.name]));

    console.log(`\nLegacy instance-global plugin_config rows: ${legacyRows.length}`);
    for (const row of legacyRows) {
      console.log(`  ${row.plugin_key ?? "<orphan plugin>"}`);
      console.log(`    secret bindings in ${row.binding_companies} company/companies`);
      console.log(`    config_json: ${describeConfig(row.config_json)}`);
      console.log(`    -> will exist for all ${companies.length} company/companies after 0164`);

      const schema = (row.manifest_json as Record<string, unknown> | null)?.instanceConfigSchema;
      for (const path of collectSecretRefPaths(schema)) {
        const ref = readSecretRefAtPath(row.config_json, path)?.toLowerCase();
        if (!ref) continue;
        const ownerId = secretOwners.get(ref);
        if (!ownerId) {
          console.log(`    ${path}: references no known secret; left as-is on every row`);
          continue;
        }
        const ownerName = companyNamesById.get(ownerId) ?? ownerId;
        console.log(
          `    ${path}: kept for ${ownerName}, dropped from the other ${companies.length - 1} row(s)`,
        );
      }
    }

    const before = legacyRows.length;
    const after = before * companies.length;
    console.log(`\nplugin_config rows: ${before} before -> ${after} after (${after - before} inserted)`);

    if (companies.length === 0 && before > 0) {
      console.error(
        `\nFAIL: ${before} plugin_config row(s) but no companies to own them; 0164 will abort.`,
      );
      return 1;
    }
    console.log("\nOK: every legacy row has a company to fan out to; 0164 will apply.");
    console.log(
      "Note: the fan-out only covers the companies that exist when 0164 runs. A company\n" +
        "created afterwards gets no plugin_config row and reads as unconfigured ({}), so it\n" +
        "needs an explicit POST /api/plugins/:pluginId/config to start using a plugin.",
    );
    return 0;
  } finally {
    await sql.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to inspect the database: ${message}`);
    process.exit(2);
  });
