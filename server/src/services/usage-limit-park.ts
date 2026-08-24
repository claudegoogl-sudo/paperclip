import type { Db } from "@paperclipai/db";
import { usageLimitParks } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";

const DEFAULT_SINGLETON_KEY = "default";

export interface UsageLimitParkState {
  parked: boolean;
  parkedUntil: Date | null;
  reason: string | null;
  rawLimitText: string | null;
  sourceRunId: string | null;
  updatedAt: Date | null;
}

function toState(
  row: typeof usageLimitParks.$inferSelect | null,
  now: Date,
): UsageLimitParkState {
  if (!row || !row.parkedUntil) {
    return {
      parked: false,
      parkedUntil: row?.parkedUntil ?? null,
      reason: row?.reason ?? null,
      rawLimitText: row?.rawLimitText ?? null,
      sourceRunId: row?.sourceRunId ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }
  return {
    parked: row.parkedUntil.getTime() > now.getTime(),
    parkedUntil: row.parkedUntil,
    reason: row.reason,
    rawLimitText: row.rawLimitText,
    sourceRunId: row.sourceRunId,
    updatedAt: row.updatedAt,
  };
}

// Single instance-wide admission gate for the Claude account-wide
// usage limit. Every wake source (issue-comment wake, sweep, routine trigger,
// scheduled-retry promotion) funnels through `startNextQueuedRunForAgent` /
// `executeRun` in heartbeat.ts, which consult `isParked()` before dispatching
// a run for ANY agent in ANY company — the quota this guards is account-wide,
// so the gate must be too.
export function usageLimitParkService(db: Db) {
  async function getRow() {
    return db
      .select()
      .from(usageLimitParks)
      .where(eq(usageLimitParks.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
  }

  return {
    getState: async (now = new Date()): Promise<UsageLimitParkState> => toState(await getRow(), now),

    isParked: async (now = new Date()): Promise<boolean> => (await toState(await getRow(), now)).parked,

    // Extends the park rather than shortening it: a raced/duplicate limit hit
    // reporting an earlier (e.g. undated fallback) reset must never pull the
    // gate open before a more precise, previously-recorded reset time.
    park: async (input: {
      parkedUntil: Date;
      reason: string;
      rawLimitText: string | null;
      sourceRunId: string | null;
    }): Promise<UsageLimitParkState> => {
      const now = new Date();
      const [row] = await db
        .insert(usageLimitParks)
        .values({
          singletonKey: DEFAULT_SINGLETON_KEY,
          parkedUntil: input.parkedUntil,
          reason: input.reason,
          rawLimitText: input.rawLimitText,
          sourceRunId: input.sourceRunId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [usageLimitParks.singletonKey],
          set: {
            // Raw `sql` interpolation does not go through the column's
            // Date<->driver-value codec the way `.values()`/`.set()` do, so a
            // bare `Date` here reaches postgres.js as an unencoded object
            // (`TypeError: ... Received an instance of Date`). Pass the ISO
            // string explicitly and cast it at the SQL level instead.
            parkedUntil: sql`greatest(coalesce(${usageLimitParks.parkedUntil}, ${input.parkedUntil.toISOString()}::timestamptz), ${input.parkedUntil.toISOString()}::timestamptz)`,
            reason: input.reason,
            rawLimitText: input.rawLimitText,
            sourceRunId: input.sourceRunId,
            updatedAt: now,
          },
        })
        .returning();
      return toState(row ?? null, now);
    },

    // Clears the park early — called on the first successful run so a stale
    // park set from an earlier (possibly mis-parsed) reset time cannot outlive
    // the real limit. A no-op if nothing is currently parked.
    clear: async (input: { reason: string }): Promise<void> => {
      await db
        .update(usageLimitParks)
        .set({
          parkedUntil: null,
          reason: input.reason,
          updatedAt: new Date(),
        })
        .where(eq(usageLimitParks.singletonKey, DEFAULT_SINGLETON_KEY));
    },
  };
}

export type UsageLimitParkService = ReturnType<typeof usageLimitParkService>;
