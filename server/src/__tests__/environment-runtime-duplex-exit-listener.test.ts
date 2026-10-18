import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptDuplexChannelHostSession } from "../services/environment-runtime.ts";

type HostSession = Parameters<typeof adaptDuplexChannelHostSession>[0];

function fakeSession(exit: { exitCode: number | null; transportClosed?: boolean }): HostSession {
  return {
    write: vi.fn(),
    onData: vi.fn(),
    kill: vi.fn(),
    close: vi.fn(async () => {}),
    wait: vi.fn(async () => exit),
  } as unknown as HostSession;
}

describe("adaptDuplexChannelHostSession onExit", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    unhandled.length = 0;
  });

  it("delivers the one-time exit to the listener", async () => {
    const channel = adaptDuplexChannelHostSession(fakeSession({ exitCode: 0, transportClosed: false }));
    const listener = vi.fn();

    channel.onExit(listener);
    await new Promise((resolve) => setImmediate(resolve));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ exitCode: 0, transportClosed: false });
  });

  it("does not raise an unhandled rejection when the exit listener throws", async () => {
    process.on("unhandledRejection", onUnhandled);
    const channel = adaptDuplexChannelHostSession(fakeSession({ exitCode: 1 }));
    const listener = vi.fn(() => {
      throw new Error("listener failed");
    });

    channel.onExit(listener);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });
});
