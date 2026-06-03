/**
 * Periodic "events alive" probe for plugin board-event subscriptions (PLA-854).
 *
 * A plugin relay (e.g. paperclip-messenger) rides on host event-bus
 * subscriptions registered by the worker during setup(). If those silently
 * detach after a worker restart, the relay goes dead with no error. The
 * per-subscribe registration log surfaces the moment of (re)attach, but a
 * heartbeat that wants to know "is the relay alive right now?" needs a signal
 * it can grep WITHOUT driving a real board event.
 *
 * This probe logs a single `plugin event bus probe` line on an interval with
 * the per-plugin subscription snapshot, so:
 *   - a future heartbeat can grep the latest probe line and read each plugin's
 *     `subscriptionCount` (zero / absent ⇒ detached relay), and
 *   - the count is independent of whether any event has fired recently.
 *
 * `tick()` is exposed so the logging can be unit-tested without timers.
 */
import type { PluginEventBus } from "./plugin-event-bus.js";

export interface PluginEventSubscriptionProbeLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface PluginEventSubscriptionProbeOptions {
  eventBus: Pick<PluginEventBus, "subscriptionSnapshot">;
  logger: PluginEventSubscriptionProbeLogger;
  intervalMs: number;
}

export interface PluginEventSubscriptionProbe {
  /** Emit one probe log line immediately. Safe to call directly in tests. */
  tick(): void;
  /** Begin the periodic probe. Idempotent. */
  start(): void;
  /** Stop the periodic probe. Idempotent. */
  stop(): void;
}

export const DEFAULT_EVENT_PROBE_INTERVAL_MS = 60_000;

export function createPluginEventSubscriptionProbe(
  options: PluginEventSubscriptionProbeOptions,
): PluginEventSubscriptionProbe {
  const { eventBus, logger, intervalMs } = options;
  let timer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    const plugins = eventBus.subscriptionSnapshot();
    const totalSubscriptions = plugins.reduce((sum, p) => sum + p.subscriptionCount, 0);
    logger.info(
      {
        plugins,
        pluginCount: plugins.length,
        totalSubscriptions,
        // A plugin with subscriptions is observing events; an empty bus means
        // no plugin is currently attached to the board-event stream.
        alive: totalSubscriptions > 0,
      },
      "plugin event bus probe",
    );
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
