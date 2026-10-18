/**
 * Repair stored objects whose object key carries a ".." run.
 *
 * The historical storage builder could emit keys with ".." inside the stored
 * filename (stem+ext concatenation); every read of such keys is refused by the
 * object-key guard, so affected attachments return 400 Invalid object key.
 *
 * For each affected `assets` row this script:
 *   1. computes a readable replacement key (only the final filename segment is
 *      rewritten; structural traversal segments abort the row as REFUSED),
 *   2. verifies the stored bytes against the row's sha256 before touching
 *      anything (content-preserving by construction),
 *   3. copies the object to the new key (idempotent re-put when the target
 *      already holds identical bytes), then updates the row with an
 *      optimistic `WHERE object_key = <old>` guard, then deletes the old
 *      object. A crash between any two steps converges on the next run.
 *
 * Safety:
 *   - Default mode is DRY-RUN: it reads and reports, never writes.
 *   - Pass --apply to mutate. Review the dry-run output first.
 *   - Run against live storage only by the operator/CTO after review.
 *
 * Usage:
 *   pnpm --filter @paperclipai/server exec tsx scripts/repair-storage-object-keys.ts [--list]
 *     [--attachment <uuid>] [--asset <uuid>] [--company <uuid>]
 *     [--max-bytes <n>] [--sweep-orphans] [--apply]
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";


import {
  and,
  assets,
  buildEmbeddedPostgresConnectionString,
  eq,
  like,
  createDb,
  issueAttachments,
  readEmbeddedPostgresCredential,
  socketDirectoryPathFor,
} from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { createStorageProviderFromConfig } from "../server/src/storage/provider-registry.js";
import { isObjectKeyReadable, repairObjectKey } from "../server/src/storage/object-key.js";
import type { StorageProvider } from "../server/src/storage/types.js";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

interface RowOutcome {
  assetId: string;
  companyId: string;
  oldKey: string;
  newKey: string | null;
  action: "would-repair" | "repaired" | "skipped-clean" | "refused" | "identical-target";
  detail?: string;
}

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function resolveDbUrl(): Promise<string> {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl;
  if (dbUrl) return dbUrl;
  const cred = readEmbeddedPostgresCredential(config.embeddedPostgresDataDir);
  if (!cred) {
    throw new Error(
      "Cannot resolve embedded PostgreSQL connection: no per-install credential file found beside " +
        `data dir ${config.embeddedPostgresDataDir}. Start the Paperclip server once so it generates ` +
        "one, then re-run this script.",
    );
  }
  return buildEmbeddedUrl(config.embeddedPostgresPort, cred.password, config.embeddedPostgresDataDir);
}

function buildEmbeddedUrl(port: number, password: string, dataDir: string): string {
  return buildEmbeddedPostgresConnectionString({
    port,
    database: "paperclip",
    password,
    socketDir: socketDirectoryPathFor(dataDir),
  });
}

async function readObjectBody(provider: StorageProvider, objectKey: string): Promise<Buffer> {
  const object = await provider.getObject({ objectKey });
  const chunks: Buffer[] = [];
  for await (const chunk of object.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

async function main() {
  const apply = hasFlag("--apply");
  const listOnly = hasFlag("--list");
  const sweepOrphans = hasFlag("--sweep-orphans");
  const attachmentId = parseFlag("--attachment");
  const assetId = parseFlag("--asset");
  const companyIdFilter = parseFlag("--company");
  const maxBytes = Number(parseFlag("--max-bytes") ?? String(DEFAULT_MAX_BYTES));

  const config = loadConfig();
  const provider = createStorageProviderFromConfig(config);
  const db = createDb(await resolveDbUrl());

  console.log(`repair-storage-object-keys mode=${apply ? "APPLY" : "DRY-RUN"} provider=${provider.id}`);
  if (!apply) {
    console.log("dry-run: no writes will be performed; pass --apply after reviewing this output");
  }

  let rows: Array<{
    id: string;
    companyId: string;
    provider: string;
    objectKey: string;
    contentType: string;
    byteSize: number;
    sha256: string;
  }>;

  if (attachmentId) {
    const joined = await db
      .select({
        id: assets.id,
        companyId: assets.companyId,
        provider: assets.provider,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .where(eq(issueAttachments.id, attachmentId));
    rows = joined;
  } else if (assetId) {
    rows = await db
      .select({
        id: assets.id,
        companyId: assets.companyId,
        provider: assets.provider,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
      })
      .from(assets)
      .where(eq(assets.id, assetId));
  } else {
    const conditions = [like(assets.objectKey, "%..%")];
    if (companyIdFilter) conditions.push(eq(assets.companyId, companyIdFilter));
    rows = await db
      .select({
        id: assets.id,
        companyId: assets.companyId,
        provider: assets.provider,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
      })
      .from(assets)
      .where(and(...conditions));
  }

  if (listOnly) {
    for (const row of rows) {
      console.log(
        `asset=${row.id} company=${row.companyId} provider=${row.provider} bytes=${row.byteSize} key=${row.objectKey}`,
      );
    }
    console.log(`total=${rows.length}`);
    return;
  }

  const outcomes: RowOutcome[] = [];
  for (const row of rows) {
    const base = { assetId: row.id, companyId: row.companyId, oldKey: row.objectKey };
    if (isObjectKeyReadable(row.objectKey)) {
      outcomes.push({ ...base, newKey: row.objectKey, action: "skipped-clean" });
      continue;
    }
    const newKey = repairObjectKey(row.objectKey);
    if (!newKey) {
      outcomes.push({
        ...base,
        newKey: null,
        action: "refused",
        detail: "no safe key repair (structural traversal or directory-segment dot-run)",
      });
      continue;
    }

    const collision = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.companyId, row.companyId), eq(assets.objectKey, newKey)));
    if (collision.length > 0 && collision[0].id !== row.id) {
      outcomes.push({ ...base, newKey, action: "refused", detail: "target key already used by another asset row" });
      continue;
    }

    try {
      const body = await readObjectBody(provider, row.objectKey);
      const actualSha = sha256(body);
      if (actualSha !== row.sha256) {
        outcomes.push({
          ...base,
          newKey,
          action: "refused",
          detail: `stored bytes sha256 ${actualSha} does not match row sha256 ${row.sha256}; not touching`,
        });
        continue;
      }
      if (body.length !== row.byteSize) {
        outcomes.push({
          ...base,
          newKey,
          action: "refused",
          detail: `stored bytes length ${body.length} does not match row byteSize ${row.byteSize}; not touching`,
        });
        continue;
      }
      if (body.length > maxBytes) {
        outcomes.push({ ...base, newKey, action: "refused", detail: `object exceeds --max-bytes ${maxBytes}` });
        continue;
      }

      const existingHead = await provider.headObject({ objectKey: newKey });
      if (existingHead.exists) {
        const existingBody = await readObjectBody(provider, newKey);
        if (sha256(existingBody) !== row.sha256) {
          outcomes.push({
            ...base,
            newKey,
            action: "refused",
            detail: "target key already holds different bytes",
          });
          continue;
        }
        // Target already holds identical bytes from an earlier interrupted run.
        if (!apply) {
          outcomes.push({ ...base, newKey, action: "would-repair" });
          continue;
        }
      } else if (!apply) {
        outcomes.push({ ...base, newKey, action: "would-repair" });
        continue;
      } else {
        await provider.putObject({
          objectKey: newKey,
          body,
          contentType: row.contentType,
          contentLength: body.length,
        });
      }

      if (apply) {
        const updated = await db
          .update(assets)
          .set({ objectKey: newKey, updatedAt: new Date() })
          .where(and(eq(assets.id, row.id), eq(assets.objectKey, row.objectKey)))
          .returning({ id: assets.id });
        if (updated.length === 0) {
          outcomes.push({
            ...base,
            newKey,
            action: "refused",
            detail: "row changed concurrently (optimistic guard missed); re-run to converge",
          });
          continue;
        }
        await provider.deleteObject({ objectKey: row.objectKey });
        outcomes.push({ ...base, newKey, action: "repaired" });
      }
    } catch (err) {
      outcomes.push({
        ...base,
        newKey,
        action: "refused",
        detail: `provider error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  for (const outcome of outcomes) {
    const key =
      outcome.action === "refused"
        ? `REFUSED ${outcome.assetId}: ${outcome.oldKey} :: ${outcome.detail}`
        : `${outcome.action} ${outcome.assetId}: ${outcome.oldKey} -> ${outcome.newKey}`;
    console.log(key);
  }

  const counts = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.action] = (acc[o.action] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`summary ${JSON.stringify(counts)}`);

  if (sweepOrphans) {
    if (provider.id !== "local_disk") {
      console.log("sweep-orphans: unsupported for non-local providers; skipping");
    } else if (!apply) {
      console.log("sweep-orphans: requires --apply; skipping in dry-run");
    } else {
      const baseDir = config.storageLocalDiskBaseDir;
      const referenced = new Set(
        (
          await db
            .select({ objectKey: assets.objectKey })
            .from(assets)
            .where(like(assets.objectKey, "%..%"))
        ).map((r) => r.objectKey),
      );
      let swept = 0;
      await walkAndSweep(baseDir, baseDir, referenced, () => {
        swept += 1;
      });
      console.log(`sweep-orphans removed=${swept}`);
    }
  }

  if (counts.refused && counts.refused > 0) {
    process.exitCode = 1;
  }
}

async function walkAndSweep(
  root: string,
  dir: string,
  referenced: Set<string>,
  onSweep: () => void,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkAndSweep(root, full, referenced, onSweep);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (!rel.includes("..")) continue;
    if (referenced.has(rel)) continue;
    await fs.rm(full, { force: true });
    onSweep();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
