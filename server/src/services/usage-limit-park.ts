import type { Db } from "@paperclipai/db";
import { usageLimitPark } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";

const DEFAULT_SINGLETON_KEY = "default";

export interface UsageLimitParkState {
  parkedUntil: Date;
  reason: string;
  rawText: string | null;
  sourceRunId: string | null;
  sourceAgentId: string | null;
  sourceCompanyId: string | null;
}

export interface SetUsageLimitParkInput {
  parkedUntil: Date;
  reason: string;
  rawText: string | null;
  sourceRunId: string | null;
  sourceAgentId: string | null;
  sourceCompanyId: string | null;
}

/**
 * PLA-1930: gates dispatch admission instance-wide when a Claude run reports
 * a usage/rate-limit hit with zero real work done. The underlying quota is
 * one shared account, not per-agent/per-company, so this is deliberately a
 * single global singleton row rather than scoped per agent/company.
 */
export function usageLimitParkService(db: Db) {
  async function getRow() {
    return db
      .select()
      .from(usageLimitPark)
      .where(eq(usageLimitPark.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
  }

  return {
    /**
     * Returns the active park, or `null` if there is no row, or the row's
     * `parkedUntil` has already passed. A naturally-expired park is left in
     * place (not deleted/cleared here) so its `reason`/`rawText` remain
     * available for observability until the next `setPark`/`clearPark` call
     * overwrites it.
     */
    getPark: async (): Promise<UsageLimitParkState | null> => {
      const row = await getRow();
      if (!row || !row.parkedUntil) return null;
      if (row.parkedUntil.getTime() <= Date.now()) return null;
      return {
        parkedUntil: row.parkedUntil,
        reason: row.reason ?? "",
        rawText: row.rawText ?? null,
        sourceRunId: row.sourceRunId ?? null,
        sourceAgentId: row.sourceAgentId ?? null,
        sourceCompanyId: row.sourceCompanyId ?? null,
      };
    },

    /**
     * Upserts the singleton park row. Implementation choice: rather than a
     * read-then-write transaction, this always takes the GREATEST of the
     * existing `parked_until` (if any) and the incoming value directly in the
     * `ON CONFLICT ... SET` clause, via raw SQL. Postgres's `GREATEST`
     * ignores NULLs unless every argument is NULL, so a cleared/never-set row
     * (`parked_until IS NULL`) always adopts the new value, and a smaller/
     * earlier reclassification from a straggler run can never shrink an
     * already-active, later park. This is simpler than a transactional
     * read-then-write and has no race window since it's a single statement.
     */
    setPark: async (input: SetUsageLimitParkInput): Promise<void> => {
      const now = new Date();
      await db
        .insert(usageLimitPark)
        .values({
          singletonKey: DEFAULT_SINGLETON_KEY,
          parkedUntil: input.parkedUntil,
          reason: input.reason,
          rawText: input.rawText,
          sourceRunId: input.sourceRunId,
          sourceAgentId: input.sourceAgentId,
          sourceCompanyId: input.sourceCompanyId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [usageLimitPark.singletonKey],
          set: {
            parkedUntil: sql`GREATEST(${usageLimitPark.parkedUntil}, excluded.parked_until)`,
            // These descriptive fields always follow whichever event most
            // recently called setPark (i.e. the one that "won" via GREATEST
            // above in the common case; in the rare case an older, still-later
            // park wins, these fields lag it slightly, which is acceptable for
            // a purely-informational audit trail).
            reason: input.reason,
            rawText: input.rawText,
            sourceRunId: input.sourceRunId,
            sourceAgentId: input.sourceAgentId,
            sourceCompanyId: input.sourceCompanyId,
            updatedAt: now,
          },
        });
    },

    clearPark: async (reason: string): Promise<void> => {
      const row = await getRow();
      if (!row) return;
      await db
        .update(usageLimitPark)
        .set({
          parkedUntil: null,
          reason: `cleared:${reason}`,
          updatedAt: new Date(),
        })
        .where(eq(usageLimitPark.id, row.id));
    },
  };
}
