import { describe, expect, it } from "vitest";
import {
  RECOVERY_REPLAY_JITTER_MIN_DELAY_MS,
  RECOVERY_REPLAY_JITTER_SPAN_MS,
  RECOVERY_REPLAY_MAX_CONCURRENT_ENV_VAR,
  computeRecoveryReplayJitterDelayMs,
  createRecoveryReplayPacer,
  defaultRecoveryReplayCap,
  resolveRecoveryReplayCap,
} from "./replay-pacing.js";

describe("recovery replay cap resolution", () => {
  it("defaults to ceil(hostCeiling / 2), never below one", () => {
    expect(defaultRecoveryReplayCap(1)).toBe(1);
    expect(defaultRecoveryReplayCap(2)).toBe(1);
    expect(defaultRecoveryReplayCap(3)).toBe(2);
    expect(defaultRecoveryReplayCap(4)).toBe(2);
    expect(defaultRecoveryReplayCap(5)).toBe(3);
    expect(defaultRecoveryReplayCap(10)).toBe(5);
  });

  it("survives a nonsensical host ceiling", () => {
    expect(defaultRecoveryReplayCap(0)).toBe(1);
    expect(defaultRecoveryReplayCap(Number.NaN)).toBe(1);
  });

  it("honours a valid env override and clamps it to the host ceiling", () => {
    expect(resolveRecoveryReplayCap("1", 8)).toMatchObject({ value: 1, source: "env" });
    expect(resolveRecoveryReplayCap("3", 8)).toMatchObject({ value: 3, source: "env" });
    // A cap above the ceiling is meaningless: admission would not let more through.
    expect(resolveRecoveryReplayCap("64", 8)).toMatchObject({ value: 8, source: "env" });
  });

  it("falls back to the default when the env var is unset, blank, or unusable", () => {
    expect(resolveRecoveryReplayCap(undefined, 4)).toMatchObject({ value: 2, source: "default" });
    expect(resolveRecoveryReplayCap("", 4)).toMatchObject({ value: 2, source: "default" });
    expect(resolveRecoveryReplayCap("   ", 4)).toMatchObject({ value: 2, source: "default" });
    for (const raw of ["0", "-2", "abc"]) {
      expect(resolveRecoveryReplayCap(raw, 4)).toMatchObject({
        value: 2,
        source: "default",
        invalidEnvValue: raw,
      });
    }
  });

  it("exports the documented env var name", () => {
    expect(RECOVERY_REPLAY_MAX_CONCURRENT_ENV_VAR).toBe("PAPERCLIP_RECOVERY_REPLAY_MAX_CONCURRENT");
  });
});

describe("recovery replay jitter", () => {
  it("spans [min, min + span] inclusive at the random extremes", () => {
    expect(computeRecoveryReplayJitterDelayMs(() => 0)).toBe(RECOVERY_REPLAY_JITTER_MIN_DELAY_MS);
    expect(computeRecoveryReplayJitterDelayMs(() => 1)).toBe(
      RECOVERY_REPLAY_JITTER_MIN_DELAY_MS + RECOVERY_REPLAY_JITTER_SPAN_MS + 1,
    );
  });

  it("never returns less than the documented 2s floor", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      expect(computeRecoveryReplayJitterDelayMs(() => r)).toBeGreaterThanOrEqual(2000);
    }
  });

  it("clamps an out-of-range random source", () => {
    expect(computeRecoveryReplayJitterDelayMs(() => -5)).toBe(RECOVERY_REPLAY_JITTER_MIN_DELAY_MS);
    expect(computeRecoveryReplayJitterDelayMs(() => 9)).toBe(
      RECOVERY_REPLAY_JITTER_MIN_DELAY_MS + RECOVERY_REPLAY_JITTER_SPAN_MS + 1,
    );
  });
});

function fakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function immediateSleeps() {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

describe("recovery replay pacer", () => {
  it("bounds concurrent dispatches to the cap and releases slots on completion", async () => {
    const clock = fakeClock();
    const { sleep } = immediateSleeps();
    const pacer = createRecoveryReplayPacer({
      cap: 2,
      minDelayMs: 0,
      jitterSpanMs: 0,
      random: () => 0,
      now: clock.now,
      setTimeoutImpl: sleep,
    });

    let active = 0;
    let maxActive = 0;
    const wake = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(50);
      active -= 1;
      return "ok";
    };
    const paced = pacer.wrapWake(wake);

    const results = await Promise.all(Array.from({ length: 6 }, () => paced("agent-a")));
    expect(results).toEqual(Array.from({ length: 6 }, () => "ok"));
    expect(maxActive).toBe(2);
    expect(pacer.stats()).toMatchObject({ cap: 2, inFlight: 0, waiting: 0, dispatched: 6, maxObservedInFlight: 2 });
  });

  it("keeps at least minDelayMs between dispatch starts (jittered spacing)", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const pacer = createRecoveryReplayPacer({
      cap: 4,
      minDelayMs: 100,
      jitterSpanMs: 0,
      random: () => 0,
      now: clock.now,
      // Sleep advances the fake clock by the requested wait, so spacing is driven
      // entirely by the pacer, never by real timers.
      setTimeoutImpl: async (ms) => {
        clock.advance(Math.max(0, ms));
      },
    });
    const paced = pacer.wrapWake(async () => {
      starts.push(clock.now());
    });

    // Serial dispatches through the pacer: every start after the first must wait
    // out at least one full jitter window since the previous start.
    await paced("agent-a");
    await paced("agent-a");
    await paced("agent-a");

    expect(starts).toHaveLength(3);
    expect(starts[0]).toBe(0);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(100);
    }
  });

  it("starts an isolated wake immediately (no spacing penalty for single dispatches)", async () => {
    const clock = fakeClock();
    const pacer = createRecoveryReplayPacer({
      cap: 2,
      minDelayMs: 5000,
      jitterSpanMs: 0,
      random: () => 0,
      now: clock.now,
      setTimeoutImpl: async () => {},
    });
    const startedAt: number[] = [];
    const paced = pacer.wrapWake(async () => {
      startedAt.push(clock.now());
    });
    await paced("agent-a");
    expect(startedAt).toEqual([0]);
  });

  it("releases the slot when the wrapped wake rejects, so one failure cannot stall replay", async () => {
    const clock = fakeClock();
    const { sleep } = immediateSleeps();
    const pacer = createRecoveryReplayPacer({
      cap: 1,
      minDelayMs: 0,
      jitterSpanMs: 0,
      random: () => 0,
      now: clock.now,
      setTimeoutImpl: sleep,
    });
    const failing = pacer.wrapWake(async () => {
      throw new Error("adapter down");
    });
    const succeeding = pacer.wrapWake(async () => "recovered");

    await expect(failing("agent-a")).rejects.toThrow("adapter down");
    await expect(succeeding("agent-a")).resolves.toBe("recovered");
    expect(pacer.stats()).toMatchObject({ inFlight: 0, waiting: 0, dispatched: 2 });
  });

  it("serves waiters in FIFO order across a burst", async () => {
    const clock = fakeClock();
    const order: string[] = [];
    const pacer = createRecoveryReplayPacer({
      cap: 1,
      minDelayMs: 10,
      jitterSpanMs: 0,
      random: () => 0,
      now: clock.now,
      setTimeoutImpl: async (ms) => {
        clock.advance(Math.max(0, ms));
      },
    });
    const paced = pacer.wrapWake(async (agentId: string) => {
      order.push(agentId);
    });
    await Promise.all([paced("a"), paced("b"), paced("c")]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("logs one pacing line per genuinely delayed dispatch", async () => {
    const entries: Array<{ payload: Record<string, unknown>; message: string }> = [];
    const clock = fakeClock();
    const pacer = createRecoveryReplayPacer({
      cap: 1,
      minDelayMs: 10,
      jitterSpanMs: 0,
      random: () => 0,
      now: clock.now,
      setTimeoutImpl: async (ms) => {
        clock.advance(Math.max(0, ms));
      },
      logger: {
        info: (payload, message) => {
          entries.push({ payload, message });
        },
      },
    });
    const paced = pacer.wrapWake(async () => {});
    await paced("agent-a");
    await paced("agent-b");
    // The first dispatch started immediately and stays silent; only the delayed
    // one is logged, with the numbers an operator needs.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      message: "recovery replay dispatch staggered",
      payload: { event: "recovery_replay_pacing", agentId: "agent-b" },
    });
  });
});
