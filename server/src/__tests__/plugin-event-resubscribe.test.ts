/**
 * Regression + observability test for PLA-854.
 *
 * A plugin worker registers its board-event subscriptions by re-running
 * setup() (and therefore re-issuing every `events.subscribe` RPC) on each
 * worker (re)start — dev-watcher hot reload, crash auto-restart, or a
 * disable→enable cycle. On restart the loader's `unloadSingle()` first calls
 * `eventBus.clearPlugin()`, so the plugin starts from zero subscriptions and
 * the new worker MUST re-attach them for the relay to keep working.
 *
 * These tests pin two things at the host contract level:
 *   1. After a clear (restart) + re-subscribe, emitted events route to the NEW
 *      worker's notify channel (the relay re-attaches), not a stale one.
 *   2. Every (re)subscribe is observable: the host logs
 *      "plugin event subscription registered" with the running per-plugin
 *      subscription count, so a detached relay (worker alive but count stuck at
 *      0, no log lines) is diagnosable from logs alone.
 */
import { describe, expect, it, vi } from "vitest";

const infoSpy = vi.hoisted(() => vi.fn());

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: infoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

const PLUGIN_KEY = "paperclip.messenger";

function boardEvent(eventType = "issue.created"): PluginEvent {
  return {
    eventId: "evt-1",
    eventType,
    companyId: "company-1",
    occurredAt: new Date().toISOString(),
    entityId: "issue-1",
    entityType: "issue",
    payload: { projectId: "proj-1" },
  } as PluginEvent;
}

/** Build one "worker generation": fresh host services + a notify capture. */
function spawnWorkerGeneration(eventBus: ReturnType<typeof createPluginEventBus>) {
  const delivered: PluginEvent[] = [];
  const notifyWorker = (method: string, params: unknown) => {
    if (method === "onEvent") delivered.push((params as { event: PluginEvent }).event);
  };
  const services = buildHostServices(
    {} as never,
    "plugin-record-id",
    PLUGIN_KEY,
    eventBus,
    notifyWorker,
  );
  return { services, delivered };
}

describe("PLA-854: plugin event subscription survives worker restart", () => {
  it("re-attaches the relay to the new worker after a restart (clearPlugin + re-subscribe)", async () => {
    const eventBus = createPluginEventBus();

    // Generation 1: worker subscribes during setup().
    const gen1 = spawnWorkerGeneration(eventBus);
    await gen1.services.events.subscribe({ eventPattern: "issue.created" });
    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(1);

    await eventBus.emit(boardEvent());
    expect(gen1.delivered).toHaveLength(1);

    // Restart: unloadSingle() clears the plugin's subscriptions, the old worker
    // stops, a new worker process spins up and re-runs setup().
    eventBus.clearPlugin(PLUGIN_KEY);
    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(0);

    const gen2 = spawnWorkerGeneration(eventBus);
    await gen2.services.events.subscribe({ eventPattern: "issue.created" });
    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(1);

    // The relay must route to the NEW worker generation, not the stale one.
    gen1.delivered.length = 0;
    await eventBus.emit(boardEvent());
    expect(gen2.delivered).toHaveLength(1);
    expect(gen1.delivered).toHaveLength(0);
  });

  it("a stale generation's late dispose() must NOT wipe the restarted worker's live subscription", async () => {
    // This is the actual PLA-854 relay-death race. host-services dispose()
    // fires on async lifecycle/crash events (plugin.worker_stopped /
    // plugin.worker.crashed) keyed by pluginId. On a restart the new worker
    // re-subscribes through a NEW host-services instance BEFORE the old
    // generation's dispose() necessarily runs. If dispose() blunt-clears the
    // whole pluginKey bucket, that late call deletes the new generation's
    // freshly-registered subscription and the relay goes silently dead.
    const eventBus = createPluginEventBus();

    // Generation 1 attaches, then the restart path drains its bucket
    // (loader unloadSingle → eventBus.clearPlugin), exactly as in production.
    const gen1 = spawnWorkerGeneration(eventBus);
    await gen1.services.events.subscribe({ eventPattern: "issue.created" });
    eventBus.clearPlugin(PLUGIN_KEY);

    // Generation 2 (restarted worker) re-subscribes and is verified live.
    const gen2 = spawnWorkerGeneration(eventBus);
    await gen2.services.events.subscribe({ eventPattern: "issue.created" });
    await eventBus.emit(boardEvent());
    expect(gen2.delivered).toHaveLength(1);

    // Now the OLD generation's cleanup finally runs (late, out of order).
    // It must only tear down its own (already-drained) subscriptions.
    gen1.services.dispose();

    gen2.delivered.length = 0;
    await eventBus.emit(boardEvent());
    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(1);
    expect(gen2.delivered).toHaveLength(1);
  });

  it("scoped clear() removes only this generation's subscriptions, leaving siblings intact", async () => {
    const eventBus = createPluginEventBus();
    const genA = spawnWorkerGeneration(eventBus);
    const genB = spawnWorkerGeneration(eventBus);

    await genA.services.events.subscribe({ eventPattern: "issue.created" });
    await genB.services.events.subscribe({ eventPattern: "issue.created" });
    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(2);

    genA.services.dispose();

    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(1);
    await eventBus.emit(boardEvent());
    expect(genB.delivered).toHaveLength(1);
    expect(genA.delivered).toHaveLength(0);
  });

  it("relays all three kinds (comment/approval/interaction) after a restart (AC#2, kind-agnostic)", async () => {
    // The three relay kinds ride distinct board event types through the same
    // ctx.events.on(...) subscription path; the survival fix is event-kind
    // independent. Prove each routes to the restarted worker generation.
    // (End-to-end Telegram delivery for approval/interaction is covered by the
    //  PLA-848 QA harness; this pins the host-bus contract underneath it.)
    const kinds = [
      "issue.comment_added",
      "issue.thread_interaction_created",
      "issue.created",
    ];
    const eventBus = createPluginEventBus();

    const gen1 = spawnWorkerGeneration(eventBus);
    for (const k of kinds) await gen1.services.events.subscribe({ eventPattern: k });

    // Restart: drain + re-subscribe on a fresh generation.
    eventBus.clearPlugin(PLUGIN_KEY);
    const gen2 = spawnWorkerGeneration(eventBus);
    for (const k of kinds) await gen2.services.events.subscribe({ eventPattern: k });
    expect(eventBus.subscriptionCount(PLUGIN_KEY)).toBe(kinds.length);

    for (const k of kinds) await eventBus.emit(boardEvent(k));
    expect(gen2.delivered.map((e) => e.eventType).sort()).toEqual([...kinds].sort());
  });

  it("logs the running subscription count on every (re)subscribe (Ask #2 observability)", async () => {
    infoSpy.mockClear();
    const eventBus = createPluginEventBus();
    const { services } = spawnWorkerGeneration(eventBus);

    await services.events.subscribe({ eventPattern: "issue.created" });
    await services.events.subscribe({ eventPattern: "approval.created" });

    const registrationLogs = infoSpy.mock.calls.filter(
      ([, msg]) => msg === "plugin event subscription registered",
    );
    expect(registrationLogs).toHaveLength(2);
    expect(registrationLogs[0][0]).toMatchObject({
      pluginKey: PLUGIN_KEY,
      eventPattern: "issue.created",
      subscriptionCount: 1,
    });
    expect(registrationLogs[1][0]).toMatchObject({
      pluginKey: PLUGIN_KEY,
      eventPattern: "approval.created",
      subscriptionCount: 2,
    });
  });
});
