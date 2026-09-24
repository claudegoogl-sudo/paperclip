import { describe, expect, it, vi } from "vitest";
import {
  createPluginStreamBus,
  publishWorkerStreamNotification,
  type StreamSubscriber,
} from "../services/plugin-stream-bus.js";

describe("publishWorkerStreamNotification", () => {
  function makeCollector() {
    const received: Array<{ event: unknown; eventType: string }> = [];
    const listener: StreamSubscriber = (event, eventType) => {
      received.push({ event, eventType });
    };
    return { received, listener };
  }

  it("maps streams.emit to a message event carrying params.event", () => {
    const bus = createPluginStreamBus();
    const { received, listener } = makeCollector();
    bus.subscribe("klipper", "status", "company-1", listener);

    expect(
      publishWorkerStreamNotification(bus, "klipper", "streams.emit", {
        channel: "status",
        companyId: "company-1",
        event: { type: "status" },
      }),
    ).toBe(true);
    expect(received).toEqual([{ event: { type: "status" }, eventType: "message" }]);
  });

  it("maps streams.open and streams.close to their SSE event types", () => {
    const bus = createPluginStreamBus();
    const { received, listener } = makeCollector();
    bus.subscribe("klipper", "status", "company-1", listener);

    expect(
      publishWorkerStreamNotification(bus, "klipper", "streams.open", {
        channel: "status",
        companyId: "company-1",
      }),
    ).toBe(true);
    expect(
      publishWorkerStreamNotification(bus, "klipper", "streams.close", {
        channel: "status",
        companyId: "company-1",
      }),
    ).toBe(true);
    expect(received.map((r) => r.eventType)).toEqual(["open", "close"]);
  });

  it("falls back to a legacy payload key, then to the bare params", () => {
    const bus = createPluginStreamBus();
    const { received, listener } = makeCollector();
    bus.subscribe("p", "ch", "company-1", listener);

    publishWorkerStreamNotification(bus, "p", "streams.emit", {
      channel: "ch",
      companyId: "company-1",
      payload: { n: 1 },
    });
    publishWorkerStreamNotification(bus, "p", "streams.emit", {
      channel: "ch",
      companyId: "company-1",
      custom: "shape",
    });
    expect(received.map((r) => r.event)).toEqual([{ n: 1 }, { channel: "ch", companyId: "company-1", custom: "shape" }]);
  });

  it("rejects unknown methods and channel-less notifications without publishing", () => {
    const bus = createPluginStreamBus();
    const { received, listener } = makeCollector();
    bus.subscribe("p", "ch", "company-1", listener);

    expect(
      publishWorkerStreamNotification(bus, "p", "streams.dropped", { channel: "ch" }),
    ).toBe(false);
    expect(publishWorkerStreamNotification(bus, "p", "streams.emit", { companyId: "company-1" })).toBe(false);
    expect(received).toEqual([]);
  });
});
