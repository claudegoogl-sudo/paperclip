/**
 * Plugin event-relay liveness probe (PLA-854).
 *
 * A plugin's board-event relay is delivered by in-process subscriptions on the
 * `PluginEventBus`, established when the worker calls `events.subscribe` during
 * `setup()`. If a worker (re)start tears those subscriptions down without the
 * worker re-establishing them, the relay goes silent with no error — the worker
 * keeps running and nothing observes that board events have stopped flowing.
 *
 * This probe periodically samples the live subscription count for every running
 * plugin and warns when a plugin that has previously held subscriptions drops to
 * zero while still running (a "detached relay"). It is intentionally
 * self-calibrating via a per-plugin high-water mark, so plugins that legitimately
 * never subscribe never trip it, and no manifest introspection is required.
 *
 * A short zero-streak threshold debounces the sub-second window during a bare
 * worker bounce, where subscriptions are briefly cleared before the restarted
 * worker re-subscribes.
 */

export interface RunningPlugin {
  pluginId: string;
  pluginKey: string;
}

export interface EventRelayProbeLogger {
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

export interface EventRelayProbeDeps {
  /** Snapshot of plugins whose worker is currently running. */
  listRunningPlugins: () => RunningPlugin[];
  /** Live event-bus subscription count for a plugin key. */
  subscriptionCount: (pluginKey: string) => number;
  log: EventRelayProbeLogger;
  /** Sampling interval. Defaults to 60s. */
  intervalMs?: number;
  /**
   * Number of consecutive zero samples (after having seen subscriptions) before
   * a detached relay is reported. Defaults to 2 so a single sample landing in a
   * restart's clear→resubscribe window does not produce a spurious warning.
   */
  zeroStreakThreshold?: number;
}

interface PluginProbeState {
  maxSeen: number;
  zeroStreak: number;
  warned: boolean;
}

export interface EventRelayProbe {
  /** Run a single sampling pass (exposed for tests and on-demand checks). */
  tick(): void;
  /** Begin periodic sampling. Idempotent. */
  start(): void;
  /** Stop periodic sampling. */
  stop(): void;
}

export function createEventRelayProbe(deps: EventRelayProbeDeps): EventRelayProbe {
  const intervalMs = deps.intervalMs ?? 60_000;
  const zeroStreakThreshold = deps.zeroStreakThreshold ?? 2;
  const states = new Map<string, PluginProbeState>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    const running = deps.listRunningPlugins();
    const liveKeys = new Set<string>();

    for (const { pluginId, pluginKey } of running) {
      liveKeys.add(pluginKey);
      const count = deps.subscriptionCount(pluginKey);
      let state = states.get(pluginKey);
      if (!state) {
        state = { maxSeen: 0, zeroStreak: 0, warned: false };
        states.set(pluginKey, state);
      }

      if (count > 0) {
        state.maxSeen = Math.max(state.maxSeen, count);
        state.zeroStreak = 0;
        if (state.warned) {
          state.warned = false;
          deps.log.info(
            { pluginId, pluginKey, eventSubscriptions: count },
            "plugin event relay recovered: subscriptions re-established",
          );
        }
        continue;
      }

      // count === 0
      if (state.maxSeen === 0) {
        // Never subscribed — not a relay plugin; nothing to assert.
        continue;
      }
      state.zeroStreak += 1;
      if (state.zeroStreak >= zeroStreakThreshold && !state.warned) {
        state.warned = true;
        deps.log.warn(
          {
            pluginId,
            pluginKey,
            eventSubscriptions: 0,
            previousMax: state.maxSeen,
            zeroStreak: state.zeroStreak,
          },
          "plugin event relay detached: worker is running but holds no event subscriptions (board events are not being delivered)",
        );
      }
    }

    // Drop state for plugins that are no longer running so a later reinstall
    // starts from a clean high-water mark.
    for (const key of states.keys()) {
      if (!liveKeys.has(key)) states.delete(key);
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    // Do not keep the event loop alive solely for the probe.
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { tick, start, stop };
}
