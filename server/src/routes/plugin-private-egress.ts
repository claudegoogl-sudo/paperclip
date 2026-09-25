import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { pluginCompanySettings, plugins } from "@paperclipai/db";
import { eq, or } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { assertInstanceAdmin, getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import {
  MAX_PRIVATE_EGRESS_ORIGINS,
  loadPluginPrivateEgressOrigins,
  setPluginPrivateEgressOrigins,
} from "../services/plugin-private-egress.js";

// ---------------------------------------------------------------------------
// Instance-admin surface for the plugin `ctx.http.fetch` private-origin
// opt-in (see services/plugin-private-egress.ts).
//
// Why instance scope and not company scope: http.fetch carries no company id,
// so any opt-in is plugin-wide by construction and reaches every tenant's
// jobs on the shared worker. The host LAN is an instance resource. A company
// board must not be able to grant it, so both routes require an instance
// admin (`assertInstanceAdmin`), and the list lives on the `plugins` row.
//
// Audit: every write emits one activity event (actor + added/removed origins;
// origins are not secret) into each company that has the plugin configured,
// plus an instance-level structured log line.
// ---------------------------------------------------------------------------

const setPrivateEgressSchema = z
  .object({
    origins: z.array(z.string().max(80)).max(MAX_PRIVATE_EGRESS_ORIGINS),
  })
  .strict();

const auditLog = logger.child({ service: "plugin-private-egress" });

async function resolvePluginId(db: Db, idOrKey: string): Promise<string | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrKey);
  const rows = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(isUuid ? or(eq(plugins.id, idOrKey), eq(plugins.pluginKey, idOrKey)) : eq(plugins.pluginKey, idOrKey))
    .limit(1);
  return rows[0]?.id ?? null;
}

export function pluginPrivateEgressRoutes(db: Db) {
  const router = Router();

  router.get("/plugins/:pluginId/private-egress", async (req, res) => {
    assertInstanceAdmin(req);
    const pluginId = await resolvePluginId(db, req.params.pluginId as string);
    if (!pluginId) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    res.json({ pluginId, origins: await loadPluginPrivateEgressOrigins(db, pluginId) });
  });

  // Replace the whole list (idempotent). `{"origins": []}` is the rollback.
  router.put("/plugins/:pluginId/private-egress", validate(setPrivateEgressSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const pluginId = await resolvePluginId(db, req.params.pluginId as string);
    if (!pluginId) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    const result = await setPluginPrivateEgressOrigins(db, pluginId, req.body.origins);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error, entry: result.entry });
      return;
    }

    const actor = getActorInfo(req);
    const details = {
      pluginId,
      added: result.added,
      removed: result.removed,
      originCount: result.origins.length,
    };
    auditLog.info(
      { event: "plugin.private_egress.updated", actorType: actor.actorType, actorId: actor.actorId, ...details },
      "plugin.private_egress.updated",
    );
    if (result.added.length > 0 || result.removed.length > 0) {
      const settingRows = await db
        .select({ companyId: pluginCompanySettings.companyId })
        .from(pluginCompanySettings)
        .where(eq(pluginCompanySettings.pluginId, pluginId));
      const companyIds = new Set(settingRows.map((row) => row.companyId));
      if (req.actor.type === "board") for (const id of req.actor.companyIds ?? []) companyIds.add(id);
      await Promise.all(
        [...companyIds].map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "plugin.private_egress_updated",
            entityType: "plugin",
            entityId: pluginId,
            details,
          }),
        ),
      );
    }
    res.json({ pluginId, origins: result.origins, added: result.added, removed: result.removed });
  });

  return router;
}
