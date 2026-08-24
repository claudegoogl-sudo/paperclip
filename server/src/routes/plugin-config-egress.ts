import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { setPluginConfigEgressAllowlistSchema, enforcePluginConfigEgressAllowlistSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import {
  enforcePluginConfigEgressAllowlist,
  listPluginConfigEgressReview,
  setPluginConfigEgressAllowlist,
} from "../services/plugin-config-egress.js";

// ---------------------------------------------------------------------------
// Operator-only review + set-allowlist + enforce-flip surface for
// the plugin config-key egress allowlist (a plugin's own `format:"uri"`
// instance-config values, e.g. klipper's `moonrakerBaseUrl`). Sibling of the
// secret-binding surface in `routes/secrets.ts`, same authz shape:
// `assertBoard` is the EG1-provenance gate (agent/worker JWTs get 403 — no
// agent-invokable path to read suggestions, seed an allowlist, or flip a row),
// `assertCompanyAccess` enforces BOLA on top. The two WRITE routes
// additionally require the acting company to actually run the plugin (an
// `enabled = true` plugin_company_settings row) via `assertUriConfigKey` —
// least-privilege so a board operator of a company that doesn't run the plugin
// can't seed/flip the shared, plugin-wide allowlist (see A2). Review stays
// ungated so posture is visible regardless.
//
// IMPORTANT asymmetry these routes must not paper over: every route here is
// company-scoped (path-scoped `companyId`), but per operator amendment A2
// the runtime deny decision this feeds is NOT per-tenant — it unions
// `egressAllowlistEnforced` across EVERY company's row for the plugin. The
// enforce route's response includes the plugin-wide effect so a caller can't
// miss it; see docs/guides/board-operator/secret-egress-allowlists.md.
// ---------------------------------------------------------------------------

export function pluginConfigEgressRoutes(db: Db) {
  const router = Router();

  // Review surface: every format:"uri" config key the plugin declares, this
  // company's own allowlist row where one exists, and the plugin-WIDE
  // would-deny suggestions (harvested observations have no per-key
  // attribution). Read-only.
  router.get("/companies/:companyId/plugins/:pluginId/config-egress", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const pluginId = req.params.pluginId as string;
    assertCompanyAccess(req, companyId);
    const review = await listPluginConfigEgressReview(db, { companyId, pluginId });
    res.json(review);
  });

  // Seed/replace this company's operator-added extra destinations for one
  // config key. Never touches this row's (or any other company's)
  // `egressAllowlistEnforced` — that's a separate, explicit step below.
  router.post(
    "/companies/:companyId/plugins/:pluginId/config-egress/:configKey/allowlist",
    validate(setPluginConfigEgressAllowlistSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const pluginId = req.params.pluginId as string;
      const configKey = req.params.configKey as string;
      assertCompanyAccess(req, companyId);

      const result = await setPluginConfigEgressAllowlist(db, {
        companyId,
        pluginId,
        configKey,
        allowedEgress: req.body.allowedEgress,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "plugin.config_egress_allowlist_set",
        entityType: "plugin_config_egress_allowlist",
        entityId: `${pluginId}:${configKey}`,
        details: { pluginId, configKey, allowlistSize: result.allowedEgress.length },
      });

      res.json(result);
    },
  );

  // Flip this company's row to enforcing. NOT a per-tenant action (A2): this
  // makes the WHOLE PLUGIN start enforcing, because the runtime chokepoint ORs
  // `egressAllowlistEnforced` across every company's row for the plugin — a
  // company that never reviewed its own suggestions is affected too.
  router.post(
    "/companies/:companyId/plugins/:pluginId/config-egress/:configKey/enforce",
    validate(enforcePluginConfigEgressAllowlistSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const pluginId = req.params.pluginId as string;
      const configKey = req.params.configKey as string;
      assertCompanyAccess(req, companyId);

      const result = await enforcePluginConfigEgressAllowlist(db, { companyId, pluginId, configKey });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "plugin.config_egress_allowlist_enforced",
        entityType: "plugin_config_egress_allowlist",
        entityId: `${pluginId}:${configKey}`,
        details: {
          pluginId,
          configKey,
          allowlistSize: result.allowedEgress.length,
          pluginWideEffect: true,
        },
      });

      res.json({ ...result, pluginWideEnforced: true });
    },
  );

  return router;
}
