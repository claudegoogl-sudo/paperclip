/**
 * On-demand end-to-end verification for scripts/repair-storage-object-keys.ts.
 * Not wired into CI: it boots a throwaway embedded PostgreSQL, plants hostile
 * object keys + files, and drives the repair script in dry-run and apply modes.
 *
 * Run from the repo root after changing the repair script:
 *   ./server/node_modules/.bin/tsx scripts/repair-storage-object-keys.verify.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDb, assets, issueAttachments, issues, companies, eq } from "../packages/db/src/index.js";
import { startEmbeddedPostgresTestDatabase } from "../packages/db/src/test-embedded-postgres.js";

import { createLocalDiskStorageProvider } from "../server/src/storage/local-disk-provider.js";

const REPO = "/home/paperclip/.paperclip-worktrees/coder-6962-objkey";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function main() {
  const pg = await startEmbeddedPostgresTestDatabase("repair-verify-");
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "repair-verify-storage-"));
  const failures: string[] = [];
  try {
    const db = createDb(pg.connectionString);
    const companyId = "f6eaabc6-0000-4000-8000-000000000001";
    const issueId = "a1b1579d-0000-4000-8000-000000000002";
    await db.insert(companies).values({ id: companyId, name: "storage-repair-verify (synthetic)" });
    await db.insert(issues).values({ id: issueId, companyId, title: "synthetic" });

    const body1 = Buffer.from(`epro-content-${"p".repeat(200)}`, "utf8");
    const body2 = Buffer.from("second-file", "utf8");
    const key1 = `${companyId}/issues/${issueId}/2026/09/13/9c1f7a34-1111-4111-8111-000000000003-ProPrj_driver_v2_mirco_OP_edit..epro`;
    const key2 = `${companyId}/issues/${issueId}/2026/09/13/9c1f7a34-2222-4222-8222-000000000004-a..b.txt`;
    // structural traversal stored key — must be REFUSED, never rewritten
    const key3 = `${companyId}/issues/${issueId}/2026/09/13/9c1f7a34-3333-4333-8333-000000000005-bad../x.txt`;
    const provider = createLocalDiskStorageProvider(storageDir);
    await provider.putObject({ objectKey: key1, body: body1, contentType: "application/octet-stream", contentLength: body1.length });
    await provider.putObject({ objectKey: key2, body: body2, contentType: "text/plain", contentLength: body2.length });
    await provider.putObject({ objectKey: key3, body: Buffer.from("dir-run"), contentType: "text/plain", contentLength: 7 });

    const assetRows = await db.insert(assets).values([
      { companyId, provider: "local_disk", objectKey: key1, contentType: "application/octet-stream", byteSize: body1.length, sha256: sha(body1), originalFilename: "ProPrj_driver_v2_mirco_OP_edit..epro" },
      { companyId, provider: "local_disk", objectKey: key2, contentType: "text/plain", byteSize: body2.length, sha256: sha(body2), originalFilename: "a..b.txt" },
      { companyId, provider: "local_disk", objectKey: key3, contentType: "text/plain", byteSize: 7, sha256: sha(Buffer.from("dir-run")), originalFilename: "x.txt" },
    ]).returning();
    await db.insert(issueAttachments).values([
      { companyId, issueId, assetId: assetRows[0].id },
      { companyId, issueId, assetId: assetRows[1].id },
      { companyId, issueId, assetId: assetRows[2].id },
    ]);

    const env = {
      ...process.env,
      DATABASE_URL: pg.connectionString,
      PAPERCLIP_STORAGE_PROVIDER: "local_disk",
      PAPERCLIP_STORAGE_LOCAL_DIR: storageDir,
    };
    const script = path.join(REPO, "server/node_modules/.bin/tsx");
    const args = [path.join(REPO, "scripts/repair-storage-object-keys.ts")];

    const run = (extra: string[]) => {
      try {
        const out = execFileSync(script, [...args, ...extra], { env, encoding: "utf8", cwd: REPO, timeout: 120_000 });
        return { out, code: 0 };
      } catch (e: any) {
        return { out: String(e.stdout ?? "") + String(e.stderr ?? ""), code: e.status ?? 1 };
      }
    };

    // 1. dry-run: reports, refuses the structural case, exit 1 due to refusal
    const dry = run([]);
    console.log("=== DRY RUN OUTPUT ===\n" + dry.out);
    if (!dry.out.includes("would-repair")) failures.push("dry-run did not propose would-repair");
    if (!dry.out.includes("REFUSED")) failures.push("dry-run did not refuse the structural-traversal row");
    if (dry.out.includes("repaired ") && !dry.out.includes("would-repair")) failures.push("dry-run mutated?");
    const dryRow = await db.select().from(assets).where(eq(assets.id, assetRows[0].id));
    if (dryRow[0].objectKey !== key1) failures.push("dry-run changed the row!");

    // 2. apply
    const apply = run(["--apply"]);
    console.log("=== APPLY OUTPUT ===\n" + apply.out);
    if (!apply.out.includes("repaired")) failures.push("apply did not repair");
    if (!apply.out.includes("REFUSED")) failures.push("apply did not refuse the structural case");

    const after1 = await db.select().from(assets).where(eq(assets.id, assetRows[0].id));
    const after2 = await db.select().from(assets).where(eq(assets.id, assetRows[1].id));
    const newKey1 = `${companyId}/issues/${issueId}/2026/09/13/9c1f7a34-1111-4111-8111-000000000003-ProPrj_driver_v2_mirco_OP_edit.epro`;
    const newKey2 = `${companyId}/issues/${issueId}/2026/09/13/9c1f7a34-2222-4222-8222-000000000004-a.b.txt`;
    if (after1[0].objectKey !== newKey1) failures.push(`row1 not updated: ${after1[0].objectKey}`);
    if (after2[0].objectKey !== newKey2) failures.push(`row2 not updated: ${after2[0].objectKey}`);
    if (after1[0].sha256 !== sha(body1)) failures.push("row1 sha changed!");
    if (after2[0].sha256 !== sha(body2)) failures.push("row2 sha changed!");

    // old objects gone, new bytes identical
    const got1 = await provider.getObject({ objectKey: newKey1 });
    const chunks: Buffer[] = [];
    for await (const c of got1.stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    if (Buffer.concat(chunks).equals(body1) === false) failures.push("repaired bytes differ!");
    const oldHead = await provider.headObject({ objectKey: key1 });
    if (oldHead.exists) failures.push("old object still present");

    // 3. idempotency: re-run apply converges
    const rerun = run(["--apply"]);
    console.log("=== RERUN OUTPUT ===\n" + rerun.out);
    // Repaired rows no longer match the '..' filter, so the re-run must find
    // nothing to do (convergence), leaving only the refused structural row.
    if (rerun.out.includes("repaired") || rerun.out.includes("would-repair")) {
      failures.push("re-run still reported repairs (did not converge)");
    }
    if (!rerun.out.includes('summary {"refused":1}')) failures.push("re-run summary unexpected: " + rerun.out);

    // 4. attachment-id targeting resolves the asset through the join
    const targeted = run(["--list", "--attachment", "00000000-0000-4000-8000-0000000000ff"]);
    if (!targeted.out.includes("total=0")) failures.push("targeted lookup misbehaved: " + targeted.out);

    if (failures.length === 0) {
      console.log("HARNESS RESULT: ALL PASS");
    } else {
      console.log("HARNESS RESULT: FAILURES:\n- " + failures.join("\n- "));
    }
  } finally {
    await pg.cleanup();
    await fs.rm(storageDir, { recursive: true, force: true });
  }
  if (failures.length > 0) process.exitCode = 1;
}
void main();
