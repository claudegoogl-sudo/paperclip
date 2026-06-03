/**
 * Tests for the PLA-854 "events alive" probe. The probe must emit a single
 * greppable `plugin event bus probe` line carrying the per-plugin subscription
 * snapshot, so a future heartbeat can read alive/dead without driving an event.
 */
import { describe, expect, it, vi } from "vitest";

import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { createPluginEventSubscriptionProbe } from "../services/plugin-event-subscription-probe.js";

function noopHandler() {
  return Promise.resolve();
}

describe("PLA-854 plugin event subscription probe", () => {
  it("logs per-plugin subscription counts and alive=true when subscriptions exist", () => {
    const eventBus = createPluginEventBus();
    eventBus.forPlugin("paperclip.messenger").subscribe("issue.created", noopHandler);
    eventBus.forPlugin("acme.other").subscribe("issue.comment_added", noopHandler);

    const info = vi.fn();
    const probe = createPluginEventSubscriptionProbe({
      eventBus,
      logger: { info },
      intervalMs: 60_000,
    });

    probe.tick();

    expect(info).toHaveBeenCalledTimes(1);
    const [payload, msg] = info.mock.calls[0];
    expect(msg).toBe("plugin event bus probe");
    expect(payload.alive).toBe(true);
    expect(payload.totalSubscriptions).toBe(2);
    expect(payload.pluginCount).toBe(2);
    expect(payload.plugins).toEqual(
      expect.arrayContaining([
        { pluginKey: "paperclip.messenger", subscriptionCount: 1 },
        { pluginKey: "acme.other", subscriptionCount: 1 },
      ]),
    );
  });

  it("reports alive=false / empty snapshot when no plugin is subscribed (detached relay signature)", () => {
    const eventBus = createPluginEventBus();
    const info = vi.fn();
    const probe = createPluginEventSubscriptionProbe({
      eventBus,
      logger: { info },
      intervalMs: 60_000,
    });

    probe.tick();

    const [payload] = info.mock.calls[0];
    expect(payload.alive).toBe(false);
    expect(payload.totalSubscriptions).toBe(0);
    expect(payload.plugins).toEqual([]);
  });

  it("start() is idempotent and stop() halts the interval", () => {
    vi.useFakeTimers();
    try {
      const eventBus = createPluginEventBus();
      eventBus.forPlugin("paperclip.messenger").subscribe("issue.created", noopHandler);
      const info = vi.fn();
      const probe = createPluginEventSubscriptionProbe({
        eventBus,
        logger: { info },
        intervalMs: 1_000,
      });

      probe.start();
      probe.start(); // idempotent — must not double-register the timer
      vi.advanceTimersByTime(3_000);
      expect(info).toHaveBeenCalledTimes(3);

      probe.stop();
      vi.advanceTimersByTime(5_000);
      expect(info).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
