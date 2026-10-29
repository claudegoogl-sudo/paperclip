import { beforeEach, describe, expect, it, vi } from "vitest";

// `characterSlot` holds module-level singleton state (`owner`, `listeners`).
// Reset it between tests by re-importing the module fresh via
// `vi.resetModules()`, since the module exposes no reset function.
async function loadFreshCharacterSlot() {
  vi.resetModules();
  const mod = await import("./agent-character-slot");
  return mod.characterSlot;
}

describe("characterSlot", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("acquires a free slot and reports the new owner via getSnapshot", async () => {
    const characterSlot = await loadFreshCharacterSlot();
    const id = Symbol("agent-a");

    expect(characterSlot.getSnapshot()).toBeNull();
    const acquired = characterSlot.acquire(id);

    expect(acquired).toBe(true);
    expect(characterSlot.getSnapshot()).toBe(id);
  });

  it("fails to acquire an already-held slot and leaves the original owner in place", async () => {
    const characterSlot = await loadFreshCharacterSlot();
    const first = Symbol("agent-a");
    const second = Symbol("agent-b");

    expect(characterSlot.acquire(first)).toBe(true);
    const acquiredBySecond = characterSlot.acquire(second);

    expect(acquiredBySecond).toBe(false);
    expect(characterSlot.getSnapshot()).toBe(first);
  });

  it("releases the slot and allows another holder to acquire it", async () => {
    const characterSlot = await loadFreshCharacterSlot();
    const first = Symbol("agent-a");
    const second = Symbol("agent-b");

    expect(characterSlot.acquire(first)).toBe(true);
    characterSlot.release(first);

    expect(characterSlot.getSnapshot()).toBeNull();
    expect(characterSlot.acquire(second)).toBe(true);
    expect(characterSlot.getSnapshot()).toBe(second);
  });

  it("ignores a release request from an id that does not hold the slot", async () => {
    const characterSlot = await loadFreshCharacterSlot();
    const owner = Symbol("agent-a");
    const impostor = Symbol("agent-b");

    expect(characterSlot.acquire(owner)).toBe(true);
    characterSlot.release(impostor);

    // The real owner should still hold the slot; the bogus release is a no-op.
    expect(characterSlot.getSnapshot()).toBe(owner);
  });

  it("ignores a release call when the slot is already free", async () => {
    const characterSlot = await loadFreshCharacterSlot();
    const id = Symbol("agent-a");

    expect(characterSlot.getSnapshot()).toBeNull();
    expect(() => characterSlot.release(id)).not.toThrow();
    expect(characterSlot.getSnapshot()).toBeNull();
  });

  it("notifies subscribers on acquire and on release", async () => {
    const characterSlot = await loadFreshCharacterSlot();
    const id = Symbol("agent-a");
    const listener = vi.fn();

    characterSlot.subscribe(listener);

    characterSlot.acquire(id);
    expect(listener).toHaveBeenCalledTimes(1);

    characterSlot.release(id);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not notify subscribers when acquire fails on an already-held slot", async () => {
    const characterSlot = await loadFreshCharacterSlot();
    const first = Symbol("agent-a");
    const second = Symbol("agent-b");
    const listener = vi.fn();

    characterSlot.acquire(first);
    characterSlot.subscribe(listener);

    const acquired = characterSlot.acquire(second);

    expect(acquired).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify subscribers when release is a no-op (wrong id or already free)", async () => {
    const characterSlot = await loadFreshCharacterSlot();
    const owner = Symbol("agent-a");
    const impostor = Symbol("agent-b");
    const listener = vi.fn();

    characterSlot.acquire(owner);
    characterSlot.subscribe(listener);

    characterSlot.release(impostor);
    expect(listener).not.toHaveBeenCalled();

    characterSlot.release(owner);
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();
    characterSlot.release(owner);
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying a listener after it unsubscribes", async () => {
    const characterSlot = await loadFreshCharacterSlot();
    const id = Symbol("agent-a");
    const listener = vi.fn();

    const unsubscribe = characterSlot.subscribe(listener);
    unsubscribe();

    characterSlot.acquire(id);
    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers, each notified independently", async () => {
    const characterSlot = await loadFreshCharacterSlot();
    const id = Symbol("agent-a");
    const listenerOne = vi.fn();
    const listenerTwo = vi.fn();

    characterSlot.subscribe(listenerOne);
    const unsubscribeTwo = characterSlot.subscribe(listenerTwo);

    characterSlot.acquire(id);
    expect(listenerOne).toHaveBeenCalledTimes(1);
    expect(listenerTwo).toHaveBeenCalledTimes(1);

    unsubscribeTwo();
    characterSlot.release(id);
    expect(listenerOne).toHaveBeenCalledTimes(2);
    expect(listenerTwo).toHaveBeenCalledTimes(1);
  });
});
