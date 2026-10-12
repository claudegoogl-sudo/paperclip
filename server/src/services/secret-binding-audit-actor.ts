import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { getAuditActor } from "../middleware/actor-context.js";

type SqlExecutor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/**
 * Stamps the current request actor onto the open transaction as the
 * transaction-local `paperclip.actor` GUC, which
 * `company_secret_binding_posture_audit_fn` records in
 * `company_secret_binding_posture_audit.actor`.
 *
 * - Call it on the SAME transaction executor as the binding write, before it.
 * - `is_local = true`: the value dies at COMMIT/ROLLBACK, so it cannot leak to
 *   the next query on a pooled connection.
 * - No request actor (boot, migration, background work): no-op, actor stays NULL.
 * - The value holds only `<actorType>:<actorId>`.
 */
export async function stampSecretBindingAuditActor(
  executor: unknown,
  actor: string | null = getAuditActor(),
): Promise<void> {
  if (!actor) return;
  const exec = (executor as Partial<SqlExecutor> | null)?.execute;
  if (typeof exec !== "function") return;
  await (executor as SqlExecutor).execute(sql`select set_config('paperclip.actor', ${actor}, true)`);
}

/**
 * Runs a single-statement binding write with the request actor stamped. With
 * no request actor it runs `fn(db)` unchanged (no extra transaction); with one
 * it opens a transaction so the transaction-local GUC covers the write.
 */
export async function withSecretBindingAuditActor<T>(
  db: Db,
  fn: (executor: Db) => Promise<T>,
): Promise<T> {
  const actor = getAuditActor();
  if (!actor) return fn(db);
  return db.transaction(async (tx) => {
    await stampSecretBindingAuditActor(tx, actor);
    return fn(tx as unknown as Db);
  });
}
