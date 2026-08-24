/**
 * `events.subscribe` is idempotent on `(eventPattern, filter)`.
 *
 * A plugin worker re-issues every `events.subscribe` RPC whenever it re-runs
 * setup() — including plugins that re-bind to self-heal a suspected detached
 * relay, without a worker restart. Before this fix each re-bind appended a
 * second host subscription pointing at the same worker, so the plugin's
 * subscription list grew without bound and every board event fanned out N+1
 * times.
 *
 * The host-side handler is a fan-in stub (`notifyWorker("onEvent", ...)`);
 * per-handler fan-out lives in the worker's `handleOnEvent`. Collapsing
 * duplicate host subscriptions is therefore semantically lossless.
 *
 * The load-bearing half is *replace*, not *skip*: a re-bind's handler closes
 * over the current notify channel, so the surviving subscription must adopt it.
 * Skipping would pin the plugin to a dead channel with no error — the silent
 * detach failure mode this whole subsystem exists to avoid.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

const PLUGIN_KEY = "example.plugin";

function boardEvent(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventId: "evt-1",
    eventType: "issue.created",
    companyId: "company-1",
    occurredAt: new Date().toISOString(),
    entityId: "issue-1",
    entityType: "issue",
    payload: { projectId: "proj-1" },
    ...overrides,
  } as PluginEvent;
}

/** Build one "worker generation": fresh host services + a notify capture. */
function spawnWorkerGeneration(eventBus: ReturnType<typeof createPluginEventBus>) {
  const notifyCalls: PluginEvent[] = [];
  const notifyWorker = (method: string, params: unknown) => {
    if (method === "onEvent") notifyCalls.push((params as { event: PluginEvent }).event);
  };
  const services = buildHostServices(
    {} as never,
    "plugin-record-id",
    PLUGIN_KEY,
    eventBus,
    notifyWorker,
  );
  return { services, notifyCalls };
}

describe("events.subscribe is idempotent per (eventPattern, filter)", () => {
  it("repeated identical subscribes keep the count at 1 and deliver exactly once", async () => {
    const eventBus = createPluginEventBus();
    const worker = spawnWorkerGeneration(eventBus);

    for (let i = 0; i < 5; i++) {
      await worker.services.events.subscribe({ eventPattern: "issue.created" });
    }

    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(1);

    await eventBus.emit(boardEvent());
    expect(worker.notifyCalls).toHaveLength(1);
  });

  it("dedupes identical filters regardless of key ordering", async () => {
    const eventBus = createPluginEventBus();
    const worker = spawnWorkerGeneration(eventBus);

    await worker.services.events.subscribe({
      eventPattern: "issue.created",
      filter: { projectId: "proj-1", companyId: "company-1" },
    });
    await worker.services.events.subscribe({
      eventPattern: "issue.created",
      filter: { companyId: "company-1", projectId: "proj-1" },
    });

    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(1);

    await eventBus.emit(boardEvent());
    expect(worker.notifyCalls).toHaveLength(1);
  });

  it("ignores filter fields the host does not evaluate when deduping", async () => {
    // EventFilter permits arbitrary extra fields, and passesFilter ignores them
    // (the worker re-applies the full filter locally per registration). A plugin
    // that varies an inert field across re-binds — a nonce, cursor, or config
    // version — must still dedupe, or the leak survives while every re-bind
    // logs as a healthy first bind.
    const eventBus = createPluginEventBus();
    const worker = spawnWorkerGeneration(eventBus);

    await worker.services.events.subscribe({
      eventPattern: "issue.created",
      filter: { companyId: "company-1", boundAt: 1 },
    });
    await worker.services.events.subscribe({
      eventPattern: "issue.created",
      filter: { companyId: "company-1", boundAt: 2 },
    });

    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(1);

    await eventBus.emit(boardEvent());
    expect(worker.notifyCalls).toHaveLength(1);
  });

  it("treats an empty filter as equivalent to no filter", async () => {
    // `{}` reaches the host as a truthy filter and passes every event, exactly
    // like an absent filter — so the two must share a key. This is reachable
    // whenever a plugin builds its filter conditionally, or when JSON-RPC drops
    // an all-undefined filter's fields in transit.
    const eventBus = createPluginEventBus();
    const worker = spawnWorkerGeneration(eventBus);

    await worker.services.events.subscribe({ eventPattern: "issue.created" });
    await worker.services.events.subscribe({ eventPattern: "issue.created", filter: {} });
    await worker.services.events.subscribe({
      eventPattern: "issue.created",
      filter: { projectId: undefined },
    });

    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(1);

    await eventBus.emit(boardEvent());
    expect(worker.notifyCalls).toHaveLength(1);
  });

  it("re-subscribing replaces the handler so events reach the CURRENT channel", async () => {
    const eventBus = createPluginEventBus();

    // Channel A binds first.
    const channelA = spawnWorkerGeneration(eventBus);
    await channelA.services.events.subscribe({ eventPattern: "issue.created" });

    // Channel B re-binds the same key with NO clearPlugin in between — this is
    // the in-lifetime self-heal path. A skip-on-duplicate implementation would
    // leave A attached and silently strand B.
    const channelB = spawnWorkerGeneration(eventBus);
    await channelB.services.events.subscribe({ eventPattern: "issue.created" });

    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(1);

    await eventBus.emit(boardEvent());
    expect(channelB.notifyCalls).toHaveLength(1);
    expect(channelA.notifyCalls).toHaveLength(0);
  });

  it("keeps distinct patterns and distinct filters as separate subscriptions", async () => {
    const eventBus = createPluginEventBus();
    const worker = spawnWorkerGeneration(eventBus);

    await worker.services.events.subscribe({ eventPattern: "issue.created" });
    await worker.services.events.subscribe({ eventPattern: "issue.updated" });
    await worker.services.events.subscribe({
      eventPattern: "issue.created",
      filter: { projectId: "proj-1" },
    });
    await worker.services.events.subscribe({
      eventPattern: "issue.created",
      filter: { projectId: "proj-2" },
    });

    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(4);

    // issue.created for proj-1 matches the unfiltered sub and the proj-1 sub,
    // but not the proj-2 sub and not the issue.updated sub.
    await eventBus.emit(boardEvent());
    expect(worker.notifyCalls).toHaveLength(2);
  });

  it("reports replaced=false on a first bind and replaced=true on a re-bind", async () => {
    const eventBus = createPluginEventBus();
    const scoped = eventBus.forPlugin(PLUGIN_KEY);
    const handler = async () => {};

    expect(scoped.subscribe("issue.created", handler)).toEqual({ replaced: false });
    expect(scoped.subscribe("issue.created", handler)).toEqual({ replaced: true });
    // clearPlugin resets identity, so the next bind is a first bind again.
    eventBus.clearPlugin(PLUGIN_KEY);
    expect(scoped.subscribe("issue.created", handler)).toEqual({ replaced: false });
  });
});
