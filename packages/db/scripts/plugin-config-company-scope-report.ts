// Pre-split key inventory for the plugin_config operator/tenant split.
//
// Read-only. Prints, per plugin and company, the config KEY NAMES and a VALUE
// SHAPE (string/number/boolean/null/array[n]/object{k1,k2}) — never values.
// Each key is tagged with its manifest scope (x-paperclip-scope) ("tenant" or "operator") read
// from the host's own plugins.manifest_json, so reviewers can see which keys
// the split will move to plugin_operator_config.
//
// Usage:
//   pnpm --filter @paperclipai/db plugin-config-report [postgres://...]
//
// For a unix-socket-only instance, set PGHOST to the socket directory.
// Safe to re-run. Exit codes: 0 report produced, 2 could not connect.

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

export function valueShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === "object") return `object{${Object.keys(value as object).sort().join(",")}}`;
  return typeof value;
}

export function keyScope(manifest: unknown, key: string): "tenant" | "operator" {
  const schema = (manifest as { instanceConfigSchema?: { properties?: Record<string, Record<string, unknown>> } } | null)
    ?.instanceConfigSchema;
  return schema?.properties?.[key]?.["x-paperclip-scope"] === "tenant" ? "tenant" : "operator";
}

async function main(): Promise<number> {
  const { connectionString, source } = resolveConnectionString();
  const sql = postgres(connectionString, {
    max: 1,
    onnotice: () => {},
    // A unix-socket-only embedded Postgres: set PGHOST=/path/to/socket/dir.
    ...(process.env.PGHOST?.startsWith("/") ? { host: process.env.PGHOST } : {}),
  });
  try {
    const rows = await sql<{ plugin_key: string; company_id: string | null; config_json: unknown; manifest_json: unknown }[]>`
      select p.plugin_key, c.company_id, c.config_json, p.manifest_json
      from plugin_config c join plugins p on p.id = c.plugin_id
      order by p.plugin_key, c.company_id`;
    console.log(`# plugin_config key inventory (source: ${source}) — names and shapes only`);
    for (const r of rows) {
      const cfg = (r.config_json && typeof r.config_json === "object" ? r.config_json : {}) as Record<string, unknown>;
      const keys = Object.keys(cfg).sort().map((k) => `${k}:${valueShape(cfg[k])}:${keyScope(r.manifest_json, k)}`);
      console.log(`${r.plugin_key}\t${r.company_id ?? "(global)"}\t${keys.join(" ") || "(empty)"}`);
    }
    console.log(`# rows: ${rows.length}`);
    return 0;
  } catch (err) {
    console.error(`could not inspect database: ${(err as Error).message || String(err)}`);
    return 2;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
