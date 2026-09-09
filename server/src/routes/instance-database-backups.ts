import { basename } from "node:path";
import { Router } from "express";
import type { BackupRetentionPolicy, Db, RunDatabaseBackupResult } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { isCloudManagedInstance } from "../services/cloud-instance.js";
import { assertInstanceAdmin } from "./authz.js";
import { logInstanceActivity } from "./instance-activity.js";
import { logger } from "../middleware/logger.js";

export type InstanceDatabaseBackupTrigger = "manual" | "scheduled";

export type InstanceDatabaseBackupRunResult = RunDatabaseBackupResult & {
  trigger: InstanceDatabaseBackupTrigger;
  backupDir: string;
  retention: BackupRetentionPolicy;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type InstanceDatabaseBackupService = {
  runManualBackup(): Promise<InstanceDatabaseBackupRunResult>;
};

export function instanceDatabaseBackupRoutes(service: InstanceDatabaseBackupService, db: Db) {
  const router = Router();

  router.post("/instance/database-backups", async (req, res) => {
    assertInstanceAdmin(req);
    // Floor: on cloud-managed instances database backups are platform-owned.
    // The manual trigger stays off for every actor, including computed
    // owner-admins — the result would also echo the server-side backup
    // directory path, which managed tenants must not see.
    if (isCloudManagedInstance()) {
      throw forbidden("Database backups are platform-managed on cloud-managed instances", {
        code: "database_backups_platform_managed",
      });
    }
    let result: InstanceDatabaseBackupRunResult;
    try {
      result = await service.runManualBackup();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Audit: a failed backup attempt still names the actor — retention and
      // durability guarantees depend on knowing who tried.
      await logInstanceActivity(db, req, {
        action: "instance.database_backup.created",
        entityType: "instance_database_backup",
        entityId: "manual",
        details: { trigger: "manual", outcome: "failed", failureReason: message },
      }).catch((logErr) => {
        logger.error({ logErr }, "Failed to write database backup failure audit row");
      });
      throw err;
    }

    await logInstanceActivity(db, req, {
      action: "instance.database_backup.created",
      entityType: "instance_database_backup",
      // The backup file is the created entity; basename keeps server
      // directory layout out of the company-visible activity feed.
      entityId: basename(result.backupFile),
      details: {
        trigger: "manual",
        sizeBytes: result.sizeBytes,
        prunedCount: result.prunedCount,
        durationMs: result.durationMs,
      },
    });

    res.status(201).json(result);
  });

  return router;
}
