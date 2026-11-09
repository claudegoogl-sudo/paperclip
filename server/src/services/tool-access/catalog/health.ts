import { assertSupportedConnection } from "../connections/setup-policy.js";
import { connectionSetupUrl, connectionReconnectUrl } from "../identifiers.js";
import { createGitHubGrantContinuity } from "../github-grant-continuity.js";
import { createToolRuntimeSlots } from "../runtime/slots.js";
import type { ActorInfo } from "../types.js";
import { nativeProviderCatalogFor } from "../../native-provider-catalogs.js";
import { retainMcpConnectionFailure } from "../../mcp-connection-failure.js";
import { isBrowserUseConnection } from "../../browser-use-client.js";
import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, pluginConfig, plugins, toolApplications, toolConnections, toolRuntimeSlots } from "@paperclipai/db";
import type { ToolConnectionHealthCheckResult, ToolConnectionHealthStatus } from "@paperclipai/shared";
import { HttpError, unprocessable } from "../../../errors.js";

import type { ToolAccessAudit } from "../audit.js";
import type { ConnectionCredentialAccess } from "../credential-access.js";
import type { ConnectionSetupPolicy } from "../connections/setup-policy.js";
import { toConnection } from "../connections/projection.js";
import { isAgentMailConnection, type ToolCatalogDiscovery } from "./discovery.js";
import { healthFailureHttpStatus, sanitizeHttpFailure, unsupportedToolConnectionTransport } from "./failures.js";
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

type HealthDependencies = {
  now: () => Date;
  audit: ToolAccessAudit;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  discovery: ToolCatalogDiscovery;
  setupPolicy: ConnectionSetupPolicy;
  resolveCredentialHeaders: ConnectionCredentialAccess["resolveCredentialHeaders"];
  refreshManagedGitHubGrantAccess: ReturnType<typeof createGitHubGrantContinuity>["refreshManagedGitHubGrantAccess"];
  ensureRuntimeSlot: ReturnType<typeof createToolRuntimeSlots>["ensureRuntimeSlot"];
  stdioTemplateId(companyId: string, config: Record<string, unknown>): Promise<string>;
  /** Plugin tool runtime probe: number of tools the plugin currently serves (null when unknown). */
  pluginToolRuntimeProbe?: (input: { pluginKey: string }) => Promise<number | null> | number | null;
};

export function createConnectionHealth(db: Db, { now, audit, getConnectionRow, discovery, setupPolicy, resolveCredentialHeaders, refreshManagedGitHubGrantAccess, ensureRuntimeSlot, stdioTemplateId, pluginToolRuntimeProbe }: HealthDependencies) {
  const { discoverTools, remoteTools, validateAgentMailConnection, validateCogneeConnection } = discovery;

  const PLUGIN_CONNECTION_TYPE = "paperclip_plugin";

  function connectionConfigPluginKey(connection: typeof toolConnections.$inferSelect): string | null {
    const value = asRecord(connection.config).pluginKey;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  /**
   * Plugin-backed connections carry `{ pluginKey, type: "paperclip_plugin" }`
   * and no HTTP url: their tools are served by the plugin worker. Returns null
   * for genuine remote HTTP connections; throws fail-closed when the connection
   * is plugin-backed but its plugin no longer resolves (falling back to the url
   * check would misreport it as `mcp_remote_url_missing`).
   */
  async function resolvePluginConnectionContext(connection: typeof toolConnections.$inferSelect) {
    const [application] = await db
      .select({ pluginId: toolApplications.pluginId, type: toolApplications.type })
      .from(toolApplications)
      .where(eq(toolApplications.id, connection.applicationId))
      .limit(1);
    const pluginBacked = application?.type === PLUGIN_CONNECTION_TYPE
      || asRecord(connection.config).type === PLUGIN_CONNECTION_TYPE;
    if (!pluginBacked) return null;
    let plugin: typeof plugins.$inferSelect | null = null;
    if (application?.pluginId) {
      plugin = await db.select().from(plugins).where(eq(plugins.id, application.pluginId)).limit(1)
        .then((rows) => rows[0] ?? null);
    }
    if (!plugin) {
      const pluginKey = connectionConfigPluginKey(connection);
      if (pluginKey) {
        plugin = await db.select().from(plugins).where(eq(plugins.pluginKey, pluginKey)).limit(1)
          .then((rows) => rows[0] ?? null);
      }
    }
    if (!plugin) {
      throw unprocessable(
        `Plugin-backed connection does not resolve to an installed plugin (pluginKey=${connectionConfigPluginKey(connection) ?? "unknown"})`,
        { code: "mcp_remote_plugin_missing" },
      );
    }
    return { plugin };
  }

  /**
   * Health for a plugin-backed mcp_remote connection: (1) per-company
   * plugin_config row keyed by (plugin.id, connection.companyId); missing row
   * fails closed; (2) a `url` in that config -> live tools/list probe of that
   * endpoint; (3) otherwise healthy only when the plugin runtime reports
   * registered tools. An unwired probe fails closed.
   */
  async function checkPluginConnectionHealth(
    connection: typeof toolConnections.$inferSelect,
    plugin: typeof plugins.$inferSelect,
    actor?: ActorInfo,
  ): Promise<string> {
    if (plugin.status === "uninstalled") {
      throw unprocessable(`Plugin ${plugin.pluginKey} is uninstalled`, { code: "mcp_remote_plugin_missing" });
    }
    const [configRow] = await db
      .select()
      .from(pluginConfig)
      .where(and(eq(pluginConfig.pluginId, plugin.id), eq(pluginConfig.companyId, connection.companyId)))
      .limit(1);
    const configRecord = asRecord(configRow?.configJson);
    const configuredUrl = typeof configRecord.url === "string" ? configRecord.url.trim() : "";
    if (configuredUrl.length > 0) {
      const probeConnection = { ...connection, config: { ...(connection.config ?? {}), url: configuredUrl } };
      await remoteTools(probeConnection, undefined, actor);
      return `Plugin ${plugin.pluginKey} endpoint responded to tools/list.`;
    }
    if (!configRow) {
      throw unprocessable(
        `Plugin ${plugin.pluginKey} is not configured for this company`,
        { code: "mcp_remote_plugin_unconfigured" },
      );
    }
    const toolCount = pluginToolRuntimeProbe
      ? await pluginToolRuntimeProbe({ pluginKey: plugin.pluginKey })
      : null;
    if (toolCount === null || toolCount < 1) {
      throw new HttpError(502, `Plugin ${plugin.pluginKey} runtime has no registered tools`, {
        code: "mcp_remote_plugin_unavailable",
      });
    }
    return `Plugin ${plugin.pluginKey} is running with ${toolCount} registered ${toolCount === 1 ? "tool" : "tools"}.`;
  }
  const { assertConnectorConnectionSetupEnabled } = setupPolicy;
  async function updateConnectionHealth(
    connection: typeof toolConnections.$inferSelect,
    status: ToolConnectionHealthStatus,
    message: string | null,
  ) {
    const now = new Date();
    const [updated] = await db
      .update(toolConnections)
      .set({
        healthStatus: status,
        healthMessage: message,
        healthCheckedAt: now,
        lastHealthAt: now,
        lastError: status === "ok" ? null : message,
        updatedAt: now,
      })
      .where(eq(toolConnections.id, connection.id))
      .returning();
    if (connection.transport === "local_stdio") {
      await db
        .update(toolRuntimeSlots)
        .set({
          healthStatus: status,
          healthMessage: message,
          lastHealthCheckAt: now,
          updatedAt: now,
        })
        .where(eq(toolRuntimeSlots.connectionId, connection.id));
    }
    return updated;
  }

  async function checkConnectionHealth(
    connectionId: string,
    actor?: ActorInfo,
    options: { allowUnauthenticatedProbe?: boolean } = {},
  ): Promise<ToolConnectionHealthCheckResult> {
    const connection = await getConnectionRow(connectionId);
    if (connection.connectionPurpose === "ai") return { connection: toConnection(connection), runtimeSlot: null };
    await assertConnectorConnectionSetupEnabled(connection);
    const unavailableServices: string[] = [];
    try {
      assertSupportedConnection(connection);
      const config = asRecord(connection.config);
      const oauth = asRecord(config.oauth);
      let pluginOkMessage: string | null = null;
      if (
        config.sourceTemplateKey === "github" &&
        oauth.connectorProfile === "github.code"
      ) {
        const activeGrants = await db
          .select()
          .from(connectionGrants)
          .where(
            and(
              eq(connectionGrants.companyId, connection.companyId),
              eq(connectionGrants.connectionId, connection.id),
              eq(connectionGrants.status, "active"),
            ),
          );
        const actorGrant =
          actor?.actorType === "user"
            ? activeGrants.find(
                (grant) =>
                  grant.kind === "user" &&
                  grant.subjectUserId === actor.actorId,
              )
            : null;
        const grantsToCheck =
          connection.credentialPolicy === "per_user" &&
          actor?.actorType === "user"
            ? actorGrant
              ? [actorGrant]
              : []
            : actorGrant
              ? [actorGrant]
              : activeGrants;
        if (grantsToCheck.length === 0)
          throw unprocessable("GitHub authorization must be connected", {
            code: "oauth_reauthorization_required",
          });
        for (const grant of grantsToCheck)
          await refreshManagedGitHubGrantAccess(connection, grant, actor);
      } else if (isBrowserUseConnection(connection) || nativeProviderCatalogFor(connection)) {
        await discoverTools(connection, undefined, actor);
      } else if (isAgentMailConnection(connection)) {
        await validateAgentMailConnection(connection);
      } else if (connection.transport === "mcp_remote") {
        const pluginContext = await resolvePluginConnectionContext(connection);
        if (pluginContext) {
          pluginOkMessage = await checkPluginConnectionHealth(connection, pluginContext.plugin, actor);
        } else {
        const canProbeWithoutAuthorization =
          options.allowUnauthenticatedProbe === true &&
          connection.status === "draft" &&
          connection.authKind === "none" &&
          connection.credentialPolicy === "per_user" &&
          actor?.actorType === "user" &&
          actor.actorId === connection.createdByUserId;
        const credentialHeaders =
          connection.credentialSource === "vercel_connect"
            ? await resolveCredentialHeaders(connection, actor, {
                forceRefresh: true,
              })
            : canProbeWithoutAuthorization
              ? {}
              : undefined;
        await remoteTools(connection, credentialHeaders, actor, undefined, unavailableServices);
        }
      } else if (connection.transport === "local_stdio") {
        await resolveCredentialHeaders(connection);
        await stdioTemplateId(connection.companyId, connection.config);
        await validateCogneeConnection(connection, actor, false);
      } else {
        throw unsupportedToolConnectionTransport();
      }
      const updated = await updateConnectionHealth(
        connection,
        "ok",
        pluginOkMessage ?? (unavailableServices.length > 0
          ? `Connected. Google services unavailable: ${unavailableServices.join(", ")}. Other services remain available; retry refreshing actions.`
          : config.sourceTemplateKey === "github" &&
          oauth.connectorProfile === "github.code"
          ? "GitHub account, installation, and repository access are available."
          : nativeProviderCatalogFor(connection)
            ? `${nativeProviderCatalogFor(connection)!.name} API access is connected.`
          : isBrowserUseConnection(connection)
            ? "Browser Use API key is connected."
          : isAgentMailConnection(connection)
            ? "AgentMail API key is connected."
            : connection.transport === "local_stdio"
              ? "Approved stdio template is ready."
              : "Remote MCP server responded to tools/list."),
      );
      const runtimeSlot = await ensureRuntimeSlot(updated);
      await audit({
        companyId: connection.companyId,
        connectionId: connection.id,
        action: "tool_connection.health_check",
        outcome: "success",
        actor,
        details: { transport: connection.transport },
      });
      return { connection: toConnection(updated), runtimeSlot };
    } catch (error) {
      if (
        error instanceof HttpError &&
        asRecord(error.details).code === "github_access_changed"
      )
        throw error;
      const failure = sanitizeHttpFailure(error);
      const updated = await updateConnectionHealth(
        connection,
        failure.status,
        failure.message,
      );
      const runtimeSlot =
        connection.transport === "local_stdio"
          ? await ensureRuntimeSlot(updated)
          : null;
      await audit({
        companyId: connection.companyId,
        connectionId: connection.id,
        action: "tool_connection.health_check",
        outcome: "failure",
        reasonCode: failure.code,
        actor,
        details: { status: failure.status, transport: connection.transport },
      });
      throw retainMcpConnectionFailure(error, new HttpError(healthFailureHttpStatus(failure), failure.message, {
        code: failure.code,
        connection: toConnection(updated),
        runtimeSlot,
        setupUrl: connectionSetupUrl(connection),
        reconnectUrl: connectionReconnectUrl(connection),
      }));
    }
  }

  async function sweepConnectionHealth(
    input: { staleAfterMs?: number; limit?: number } = {},
  ) {
    const generatedAt = now();
    const staleAfterMs = input.staleAfterMs ?? 15 * 60 * 1000;
    const limit = input.limit ?? 25;
    const cutoff = new Date(generatedAt.getTime() - staleAfterMs);
    // Legacy plugin backfills use a remote transport as a placeholder, but
    // their tools run in the plugin worker and have no remote MCP endpoint.
    // Select only due IDs in SQL so each scheduler tick does not decode every
    // active connection's config and credential metadata.
    const due = await db
      .select({ id: toolConnections.id })
      .from(toolConnections)
      .innerJoin(toolApplications, and(
        eq(toolApplications.id, toolConnections.applicationId),
        eq(toolApplications.companyId, toolConnections.companyId),
      ))
      .where(
        and(
          eq(toolConnections.enabled, true),
          eq(toolConnections.status, "active"),
          ne(toolConnections.transport, "chat_sdk"),
          ne(toolConnections.transport, "runtime_auth"),
          // Plugin-backed connections that carry a pluginKey ARE swept (health via
          // per-company plugin config / runtime probe); legacy backfills without one stay excluded.
          or(
            ne(toolApplications.type, "paperclip_plugin"),
            sql`${toolConnections.config} ->> 'pluginKey' is not null`,
          ),
          or(isNull(toolConnections.healthCheckedAt), lte(toolConnections.healthCheckedAt, cutoff)),
        ),
      )
      .orderBy(
        sql`${toolConnections.healthCheckedAt} asc nulls first`,
        asc(toolConnections.createdAt),
        asc(toolConnections.id),
      )
      .limit(limit);
    let healthy = 0;
    let failed = 0;
    const failedConnectionIds: string[] = [];
    for (const connection of due) {
      try {
        await checkConnectionHealth(connection.id, {
          actorType: "system",
          actorId: "tool_health_sweep",
        });
        healthy += 1;
      } catch {
        failed += 1;
        failedConnectionIds.push(connection.id);
      }
    }
    return {
      checked: due.length,
      healthy,
      failed,
      failedConnectionIds,
    };
  }
  return { updateConnectionHealth, checkConnectionHealth, sweepConnectionHealth };
}
export type ConnectionHealth = ReturnType<typeof createConnectionHealth>;
