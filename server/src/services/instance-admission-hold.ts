import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceAdmissionHolds } from "@paperclipai/db";

const DEFAULT_SINGLETON_KEY = "default";

/** Longest hold the API accepts. A larger `holdUntil` is capped to now + this. */
export const INSTANCE_ADMISSION_HOLD_MAX_MS = 60 * 60 * 1000;

export interface InstanceAdmissionHoldState {
  held: boolean;
  holdUntil: Date | null;
  reason: string | null;
  setByActorType: string | null;
  setByActorId: string | null;
  updatedAt: Date | null;
}

function toState(
  row: typeof instanceAdmissionHolds.$inferSelect | null,
  now: Date,
): InstanceAdmissionHoldState {
  const holdUntil = row?.holdUntil ?? null;
  return {
    held: holdUntil !== null && holdUntil.getTime() > now.getTime(),
    holdUntil,
    reason: row?.reason ?? null,
    setByActorType: row?.setByActorType ?? null,
    setByActorId: row?.setByActorId ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Caps a requested hold end at now + INSTANCE_ADMISSION_HOLD_MAX_MS. */
export function capInstanceAdmissionHoldUntil(requested: Date, now = new Date()): Date {
  const max = now.getTime() + INSTANCE_ADMISSION_HOLD_MAX_MS;
  return new Date(Math.min(requested.getTime(), max));
}

/**
 * Operator-set, admission-only hold on the whole instance. While held, the
 * scheduler starts no queued run; queued runs stay queued and running runs
 * finish normally. Separate from the usage-limit park on purpose: nothing in
 * the run lifecycle clears this hold — only `clear()` or expiry.
 */
export function instanceAdmissionHoldService(db: Db) {
  async function getRow() {
    return db
      .select()
      .from(instanceAdmissionHolds)
      .where(eq(instanceAdmissionHolds.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
  }

  return {
    getState: async (now = new Date()): Promise<InstanceAdmissionHoldState> => toState(await getRow(), now),

    isHeld: async (now = new Date()): Promise<boolean> => toState(await getRow(), now).held,

    // Sets (replaces) the hold. The end time is capped server-side, so a caller
    // can never leave the instance held for longer than the max.
    set: async (input: {
      holdUntil: Date;
      reason: string;
      actorType: string | null;
      actorId: string | null;
    }): Promise<InstanceAdmissionHoldState> => {
      const now = new Date();
      const holdUntil = capInstanceAdmissionHoldUntil(input.holdUntil, now);
      const [row] = await db
        .insert(instanceAdmissionHolds)
        .values({
          singletonKey: DEFAULT_SINGLETON_KEY,
          holdUntil,
          reason: input.reason,
          setByActorType: input.actorType,
          setByActorId: input.actorId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [instanceAdmissionHolds.singletonKey],
          set: {
            holdUntil,
            reason: input.reason,
            setByActorType: input.actorType,
            setByActorId: input.actorId,
            updatedAt: now,
          },
        })
        .returning();
      return toState(row ?? null, now);
    },

    // Ends the hold. Safe to re-run: a no-op when nothing is held.
    clear: async (input: { actorType: string | null; actorId: string | null }): Promise<InstanceAdmissionHoldState> => {
      const now = new Date();
      await db
        .update(instanceAdmissionHolds)
        .set({
          holdUntil: null,
          setByActorType: input.actorType,
          setByActorId: input.actorId,
          updatedAt: now,
        })
        .where(eq(instanceAdmissionHolds.singletonKey, DEFAULT_SINGLETON_KEY));
      return toState(await getRow(), now);
    },
  };
}

export type InstanceAdmissionHoldService = ReturnType<typeof instanceAdmissionHoldService>;
