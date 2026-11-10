/**
 * SECURITY-CRITICAL: per-agent grant check for plugin tools flagged `requiresGrant`
 * (phase 1 of the plugin-tool least-privilege model). Runs on EVERY dispatch.
 * Fail closed: any lookup error, missing row or expired row is a deny.
 * Match is exact equality on (company, agent, full namespaced key); no glob.
 */
import { and, eq, gt } from "drizzle-orm";
import { pluginToolGrants, type Db } from "@paperclipai/db";

/** Exact namespaced tool keys that require a grant. */
export const GRANT_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  "platform.cad:cad.run_script",
  "platform.cad:cad.export",
  "platform.vault:vault.read",
  "platform.vault:vault.list",
]);

/** Plugin keys whose EVERY tool requires a grant (covers future vault tools). */
export const GRANT_REQUIRED_PLUGINS: ReadonlySet<string> = new Set(["platform.vault"]);

export function toolRequiresGrant(namespacedTool: string): boolean {
  if (GRANT_REQUIRED_TOOLS.has(namespacedTool)) return true;
  const i = namespacedTool.indexOf(":");
  return i > 0 && GRANT_REQUIRED_PLUGINS.has(namespacedTool.slice(0, i));
}

export type GrantDecision =
  | { allowed: true; required: boolean; grantId?: string }
  | { allowed: false; required: true; reason: "no_grant" | "lookup_error" };

export type GrantLookup = (q: {
  companyId: string;
  agentId: string;
  toolKey: string;
  now: Date;
}) => Promise<{ id: string } | null>;

export function dbGrantLookup(db: Db): GrantLookup {
  return async ({ companyId, agentId, toolKey, now }) => {
    const rows = await db
      .select({ id: pluginToolGrants.id })
      .from(pluginToolGrants)
      .where(
        and(
          eq(pluginToolGrants.companyId, companyId),
          eq(pluginToolGrants.agentId, agentId),
          eq(pluginToolGrants.toolKey, toolKey),
          gt(pluginToolGrants.expiresAt, now),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  };
}

export async function checkToolGrant(opts: {
  lookup: GrantLookup;
  companyId: string;
  agentId: string;
  namespacedTool: string;
  now?: Date;
}): Promise<GrantDecision> {
  if (!toolRequiresGrant(opts.namespacedTool)) return { allowed: true, required: false };
  try {
    const row = await opts.lookup({
      companyId: opts.companyId,
      agentId: opts.agentId,
      toolKey: opts.namespacedTool,
      now: opts.now ?? new Date(),
    });
    return row ? { allowed: true, required: true, grantId: row.id } : { allowed: false, required: true, reason: "no_grant" };
  } catch {
    return { allowed: false, required: true, reason: "lookup_error" };
  }
}
