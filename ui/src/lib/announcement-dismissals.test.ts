import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  announcementStoragePrefix as AnnouncementStoragePrefix,
  readAnnouncementDismissals as ReadAnnouncementDismissals,
  saveAnnouncementDismissal as SaveAnnouncementDismissal,
} from "./announcement-dismissals";

/**
 * announcement-dismissals.ts keeps a module-level `memory` Map as an
 * in-session fallback cache (so dismissals survive a storage failure for the
 * rest of the visit). That cache is private module state, not reset by
 * clearing localStorage, so every test below uses `vi.resetModules()` plus a
 * fresh dynamic import to get an isolated module instance. This also lets us
 * swap in a fake localStorage per test (the ui vitest environment is "node",
 * so there is no real jsdom localStorage to rely on).
 */

function createFakeLocalStorage() {
  const store = new Map<string, string>();
  let throwOnSetItem = false;

  const storage = {
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      if (throwOnSetItem) throw new DOMException("QuotaExceededError");
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    get length(): number {
      return store.size;
    },
  };

  return {
    storage,
    store,
    setThrowOnSetItem(value: boolean) {
      throwOnSetItem = value;
    },
  };
}

let fakeStorage: ReturnType<typeof createFakeLocalStorage>;
let announcementStoragePrefix: typeof AnnouncementStoragePrefix;
let readAnnouncementDismissals: typeof ReadAnnouncementDismissals;
let saveAnnouncementDismissal: typeof SaveAnnouncementDismissal;

beforeEach(async () => {
  vi.resetModules();
  fakeStorage = createFakeLocalStorage();
  vi.stubGlobal("localStorage", fakeStorage.storage);
  const mod = await import("./announcement-dismissals");
  announcementStoragePrefix = mod.announcementStoragePrefix;
  readAnnouncementDismissals = mod.readAnnouncementDismissals;
  saveAnnouncementDismissal = mod.saveAnnouncementDismissal;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("announcementStoragePrefix", () => {
  it("builds a versioned, user-scoped prefix", () => {
    expect(announcementStoragePrefix("user-1")).toBe(
      "paperclip.announcement-dismissals.v1:user-1:",
    );
  });

  it("URI-encodes userId so other-user prefixes cannot collide via special characters", () => {
    expect(announcementStoragePrefix("a:b")).toBe(
      "paperclip.announcement-dismissals.v1:a%3Ab:",
    );
    // Confirms distinct raw ids ("a:b" vs "a%3Ab") cannot be crafted to
    // produce the same prefix as a differently-named user.
    expect(announcementStoragePrefix("a:b")).not.toBe(
      announcementStoragePrefix("a%3Ab"),
    );
  });
});

describe("saveAnnouncementDismissal", () => {
  it("returns true and persists 'pending' when the write succeeds", () => {
    const result = saveAnnouncementDismissal("user-1", "new-feature", true);

    expect(result).toBe(true);
    expect(fakeStorage.store.get("paperclip.announcement-dismissals.v1:user-1:new-feature")).toBe(
      "pending",
    );
  });

  it("returns true and persists 'synced' when pending is false", () => {
    const result = saveAnnouncementDismissal("user-1", "new-feature", false);

    expect(result).toBe(true);
    expect(fakeStorage.store.get("paperclip.announcement-dismissals.v1:user-1:new-feature")).toBe(
      "synced",
    );
  });

  it("overwrites a prior value for the same user/announcement pair", () => {
    saveAnnouncementDismissal("user-1", "new-feature", true);
    const second = saveAnnouncementDismissal("user-1", "new-feature", false);

    expect(second).toBe(true);
    expect(fakeStorage.store.get("paperclip.announcement-dismissals.v1:user-1:new-feature")).toBe(
      "synced",
    );
  });

  it("keeps dismissals for different users under separate keys", () => {
    saveAnnouncementDismissal("user-1", "new-feature", true);
    saveAnnouncementDismissal("user-2", "new-feature", false);

    expect(fakeStorage.store.get("paperclip.announcement-dismissals.v1:user-1:new-feature")).toBe(
      "pending",
    );
    expect(fakeStorage.store.get("paperclip.announcement-dismissals.v1:user-2:new-feature")).toBe(
      "synced",
    );
  });

  it("returns false when the underlying localStorage write throws", () => {
    fakeStorage.setThrowOnSetItem(true);

    const result = saveAnnouncementDismissal("user-1", "new-feature", true);

    expect(result).toBe(false);
    // The key was never actually persisted to storage.
    expect(fakeStorage.store.has("paperclip.announcement-dismissals.v1:user-1:new-feature")).toBe(
      false,
    );
  });

  it(
    "falls back to the in-memory cache when storage throws, so the value " +
      "is still visible via readAnnouncementDismissals for the rest of the visit " +
      "even though the persisted write failed (return value correctly reports false)",
    () => {
      fakeStorage.setThrowOnSetItem(true);

      const result = saveAnnouncementDismissal("user-1", "new-feature", true);
      expect(result).toBe(false);

      // Re-enable storage so the read path's localStorage scan doesn't itself
      // throw; the dismissal should still surface from the in-memory fallback.
      fakeStorage.setThrowOnSetItem(false);
      const entries = readAnnouncementDismissals("user-1");
      expect(entries.get("new-feature")).toBe(true);
    },
  );
});

describe("readAnnouncementDismissals", () => {
  it("returns an empty map when nothing has been dismissed", () => {
    expect(readAnnouncementDismissals("user-1").size).toBe(0);
  });

  it("reflects dismissals saved through saveAnnouncementDismissal", () => {
    saveAnnouncementDismissal("user-1", "new-feature", true);
    saveAnnouncementDismissal("user-1", "beta-rollout", false);

    const entries = readAnnouncementDismissals("user-1");

    expect(entries.get("new-feature")).toBe(true);
    expect(entries.get("beta-rollout")).toBe(false);
    expect(entries.size).toBe(2);
  });

  it("reads entries written directly to localStorage by a prior session", () => {
    fakeStorage.store.set(
      "paperclip.announcement-dismissals.v1:user-1:prior-session",
      "pending",
    );

    const entries = readAnnouncementDismissals("user-1");

    expect(entries.get("prior-session")).toBe(true);
  });

  it("ignores keys belonging to a different user", () => {
    saveAnnouncementDismissal("user-2", "new-feature", true);

    const entries = readAnnouncementDismissals("user-1");

    expect(entries.size).toBe(0);
  });

  it("ignores storage keys whose announcement id fails the schema", () => {
    fakeStorage.store.set(
      "paperclip.announcement-dismissals.v1:user-1:Invalid_ID!",
      "pending",
    );

    expect(readAnnouncementDismissals("user-1").size).toBe(0);
  });

  it("ignores storage keys with a value other than 'pending' or 'synced'", () => {
    fakeStorage.store.set(
      "paperclip.announcement-dismissals.v1:user-1:new-feature",
      "true",
    );

    expect(readAnnouncementDismissals("user-1").size).toBe(0);
  });

  it("ignores unrelated localStorage keys that do not match the prefix", () => {
    fakeStorage.store.set("some.other.app.key", "pending");

    expect(readAnnouncementDismissals("user-1").size).toBe(0);
  });

  it("does not throw when localStorage access fails, and returns what the in-memory cache has", () => {
    saveAnnouncementDismissal("user-1", "new-feature", true);

    // Simulate a storage engine that throws on access (private browsing /
    // storage disabled) by replacing localStorage.length with a throwing
    // getter after the save already happened.
    vi.stubGlobal("localStorage", {
      ...fakeStorage.storage,
      get length(): number {
        throw new DOMException("SecurityError");
      },
    });

    expect(() => readAnnouncementDismissals("user-1")).not.toThrow();
    expect(readAnnouncementDismissals("user-1").get("new-feature")).toBe(true);
  });
});
