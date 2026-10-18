import type { Db } from "@paperclipai/db";
import { usageLimitParks } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";

const DEFAULT_SINGLETON_KEY = "default";

// Hard ceiling on how far ahead the instance-wide park may ever reach. Equal to
// the 5h ceiling `buildNoOpDispatchRetrySchedule` uses for the per-agent retry
// ladder (the longest real Claude usage-limit cycle). The adapter's reset parser
// rolls a dated reset whose day already passed to NEXT YEAR, so an unbounded park
// could freeze every agent in every company for ~365 days with no exit. A park
// clamped below the real reset is harmless: the fleet re-arms it on the next
// limit result.
export const USAGE_LIMIT_PARK_MAX_HORIZON_MS = 5 * 60 * 60 * 1000;

export function clampUsageLimitParkUntil(parkedUntil: Date, now: Date): Date {
  return new Date(Math.min(parkedUntil.getTime(), now.getTime() + USAGE_LIMIT_PARK_MAX_HORIZON_MS));
}

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

  // Caps a stored parkedUntil that is beyond the horizon (e.g. written by a
  // build without the clamp). Idempotent: a second call finds nothing to cap.
  async function getBoundedRow(now: Date) {
    const row = await getRow();
    if (!row?.parkedUntil) return row;
    const capped = clampUsageLimitParkUntil(row.parkedUntil, now);
    if (capped.getTime() >= row.parkedUntil.getTime()) return row;
    const [updated] = await db
      .update(usageLimitParks)
      .set({ parkedUntil: capped, updatedAt: now })
      .where(eq(usageLimitParks.singletonKey, DEFAULT_SINGLETON_KEY))
      .returning();
    return updated ?? row;
  }

  return {
    getState: async (now = new Date()): Promise<UsageLimitParkState> => toState(await getBoundedRow(now), now),

    isParked: async (now = new Date()): Promise<boolean> => (await toState(await getBoundedRow(now), now)).parked,

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
      const ceilingIso = new Date(now.getTime() + USAGE_LIMIT_PARK_MAX_HORIZON_MS).toISOString();
      const parkedUntil = clampUsageLimitParkUntil(input.parkedUntil, now);
      const parkedUntilIso = parkedUntil.toISOString();
      const [row] = await db
        .insert(usageLimitParks)
        .values({
          singletonKey: DEFAULT_SINGLETON_KEY,
          parkedUntil,
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
            // least(..., ceiling) also caps a far-future value already stored.
            parkedUntil: sql`least(greatest(coalesce(${usageLimitParks.parkedUntil}, ${parkedUntilIso}::timestamptz), ${parkedUntilIso}::timestamptz), ${ceilingIso}::timestamptz)`,
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
    clear: async (input: { reason: string }): Promise<UsageLimitParkState> => {
      const now = new Date();
      const [row] = await db
        .update(usageLimitParks)
        .set({
          parkedUntil: null,
          reason: input.reason,
          updatedAt: now,
        })
        .where(eq(usageLimitParks.singletonKey, DEFAULT_SINGLETON_KEY))
        .returning();
      return toState(row ?? null, now);
    },
  };
}

export type UsageLimitParkService = ReturnType<typeof usageLimitParkService>;
