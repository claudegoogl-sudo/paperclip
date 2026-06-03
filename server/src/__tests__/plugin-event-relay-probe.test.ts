/**
 * PLA-854: tests for the event-relay liveness probe.
 *
 * The probe warns when a running plugin that previously held event-bus
 * subscriptions drops to zero (a detached board-event relay), without
 * false-positiving on plugins that never subscribe or on the brief
 * clear→resubscribe window of a worker restart.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createEventRelayProbe,
  type RunningPlugin,
} from "../services/plugin-event-relay-probe.js";

function makeLog() {
  return { warn: vi.fn(), info: vi.fn() };
}

describe("createEventRelayProbe", () => {
  it("does not warn for a plugin that never subscribes", () => {
    const log = makeLog();
    const running: RunningPlugin[] = [{ pluginId: "p1", pluginKey: "no.subs" }];
    const probe = createEventRelayProbe({
      listRunningPlugins: () => running,
      subscriptionCount: () => 0,
      log,
      zeroStreakThreshold: 2,
    });

    probe.tick();
    probe.tick();
    probe.tick();

    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not warn while subscriptions are healthy", () => {
    const log = makeLog();
    const probe = createEventRelayProbe({
      listRunningPlugins: () => [{ pluginId: "p1", pluginKey: "healthy" }],
      subscriptionCount: () => 6,
      log,
      zeroStreakThreshold: 2,
    });

    probe.tick();
    probe.tick();

    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns when a previously-subscribed plugin's relay detaches", () => {
    const log = makeLog();
    let count = 6;
    const probe = createEventRelayProbe({
      listRunningPlugins: () => [{ pluginId: "p1", pluginKey: "messenger" }],
      subscriptionCount: () => count,
      log,
      zeroStreakThreshold: 2,
    });

    probe.tick(); // healthy (maxSeen = 6)
    count = 0;
    probe.tick(); // zeroStreak = 1, below threshold → no warn yet
    expect(log.warn).not.toHaveBeenCalled();
    probe.tick(); // zeroStreak = 2 → warn

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pluginKey: "messenger", eventSubscriptions: 0, previousMax: 6 }),
      expect.stringContaining("detached"),
    );
  });

  it("warns only once until the relay recovers", () => {
    const log = makeLog();
    let count = 4;
    const probe = createEventRelayProbe({
      listRunningPlugins: () => [{ pluginId: "p1", pluginKey: "messenger" }],
      subscriptionCount: () => count,
      log,
      zeroStreakThreshold: 1,
    });

    probe.tick(); // healthy
    count = 0;
    probe.tick(); // warn (threshold 1)
    probe.tick(); // still 0 → no repeat warn
    expect(log.warn).toHaveBeenCalledTimes(1);

    count = 4;
    probe.tick(); // recovered → info, warned flag reset
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ pluginKey: "messenger", eventSubscriptions: 4 }),
      expect.stringContaining("recovered"),
    );

    count = 0;
    probe.tick(); // detaches again → warns again
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("does not warn on a single transient zero (restart clear→resubscribe window)", () => {
    const log = makeLog();
    const counts = [6, 0, 6]; // healthy, momentary clear mid-restart, re-subscribed
    let i = 0;
    const probe = createEventRelayProbe({
      listRunningPlugins: () => [{ pluginId: "p1", pluginKey: "messenger" }],
      subscriptionCount: () => counts[Math.min(i, counts.length - 1)],
      log,
      zeroStreakThreshold: 2,
    });

    probe.tick(); i++;
    probe.tick(); i++; // single zero — zeroStreak = 1, below threshold
    probe.tick();      // back to 6 — streak reset

    expect(log.warn).not.toHaveBeenCalled();
  });

  it("drops state for plugins that stop running", () => {
    const log = makeLog();
    let running: RunningPlugin[] = [{ pluginId: "p1", pluginKey: "messenger" }];
    let count = 6;
    const probe = createEventRelayProbe({
      listRunningPlugins: () => running,
      subscriptionCount: () => count,
      log,
      zeroStreakThreshold: 1,
    });

    probe.tick(); // maxSeen = 6
    running = []; // plugin uninstalled / stopped
    probe.tick(); // state dropped, no warn

    // Comes back fresh (e.g. reinstall) with no subs yet — must not warn,
    // because the prior high-water mark was discarded.
    running = [{ pluginId: "p1", pluginKey: "messenger" }];
    count = 0;
    probe.tick();
    probe.tick();

    expect(log.warn).not.toHaveBeenCalled();
  });
});
