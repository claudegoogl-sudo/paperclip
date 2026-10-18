// @vitest-environment jsdom
import type { Project } from "@paperclipai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROJECT_ORDER_UPDATED_EVENT,
  PROJECT_SORT_MODE_UPDATED_EVENT,
  getProjectOrderStorageKey,
  getProjectSortModeStorageKey,
  readProjectOrder,
  readProjectSortMode,
  sortProjectsByStoredOrder,
  writeProjectOrder,
  writeProjectSortMode,
  type ProjectOrderUpdatedDetail,
  type ProjectSortModeUpdatedDetail,
} from "./project-order";

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return { id, name: id, ...overrides } as Project;
}

beforeEach(() => {
  localStorage.clear();
});

describe("getProjectOrderStorageKey / getProjectSortModeStorageKey", () => {
  it("scopes the key by company and user", () => {
    expect(getProjectOrderStorageKey("acme", "u1")).toBe("paperclip.projectOrder:acme:u1");
    expect(getProjectSortModeStorageKey("acme", "u1")).toBe("paperclip.projectSortMode:acme:u1");
  });

  it("falls back to the anonymous user for null, undefined, or blank ids", () => {
    expect(getProjectOrderStorageKey("acme", null)).toBe("paperclip.projectOrder:acme:anonymous");
    expect(getProjectOrderStorageKey("acme", undefined)).toBe("paperclip.projectOrder:acme:anonymous");
    expect(getProjectOrderStorageKey("acme", "   ")).toBe("paperclip.projectOrder:acme:anonymous");
  });

  it("trims whitespace around a real user id", () => {
    expect(getProjectOrderStorageKey("acme", "  u1  ")).toBe("paperclip.projectOrder:acme:u1");
  });
});

describe("readProjectOrder", () => {
  it("returns an empty array when nothing is stored", () => {
    expect(readProjectOrder("missing-key")).toEqual([]);
  });

  it("round-trips an array written by writeProjectOrder", () => {
    const key = "key-1";
    writeProjectOrder(key, ["a", "b", "c"]);
    expect(readProjectOrder(key)).toEqual(["a", "b", "c"]);
  });

  it("filters out non-string and empty-string entries", () => {
    const key = "key-2";
    localStorage.setItem(key, JSON.stringify(["a", 1, "", null, "b", undefined, "c"]));
    expect(readProjectOrder(key)).toEqual(["a", "b", "c"]);
  });

  it("falls back to an empty array when the stored value is not an array", () => {
    const key = "key-3";
    localStorage.setItem(key, JSON.stringify({ not: "an array" }));
    expect(readProjectOrder(key)).toEqual([]);
  });

  it("falls back to an empty array when the stored value is corrupted JSON", () => {
    const key = "key-4";
    localStorage.setItem(key, "{not valid json");
    expect(readProjectOrder(key)).toEqual([]);
  });

  it("falls back to an empty array when localStorage.getItem throws", () => {
    const key = "key-5";
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked storage access");
    });
    expect(readProjectOrder(key)).toEqual([]);
    spy.mockRestore();
  });
});

describe("readProjectSortMode", () => {
  it("defaults to 'top' when nothing is stored", () => {
    expect(readProjectSortMode("missing-key")).toBe("top");
  });

  it("round-trips a valid sort mode", () => {
    const key = "sort-key-1";
    localStorage.setItem(key, "alphabetical");
    expect(readProjectSortMode(key)).toBe("alphabetical");

    localStorage.setItem(key, "recent");
    expect(readProjectSortMode(key)).toBe("recent");
  });

  it("falls back to 'top' for an unrecognized stored value", () => {
    const key = "sort-key-2";
    localStorage.setItem(key, "not-a-real-mode");
    expect(readProjectSortMode(key)).toBe("top");
  });

  it("falls back to 'top' when localStorage.getItem throws", () => {
    const key = "sort-key-3";
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked storage access");
    });
    expect(readProjectSortMode(key)).toBe("top");
    spy.mockRestore();
  });
});

describe("writeProjectOrder", () => {
  it("persists the normalized id list to localStorage", () => {
    const key = "write-key-1";
    writeProjectOrder(key, ["x", "", "y", 42 as unknown as string, "z"]);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(["x", "y", "z"]);
  });

  it("dispatches a PROJECT_ORDER_UPDATED_EVENT with the normalized ids", () => {
    const key = "write-key-2";
    const handler = vi.fn();
    window.addEventListener(PROJECT_ORDER_UPDATED_EVENT, handler as EventListener);

    writeProjectOrder(key, ["a", "", "b"]);

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0] as CustomEvent<ProjectOrderUpdatedDetail>;
    expect(event.detail).toEqual({ storageKey: key, orderedIds: ["a", "b"] });

    window.removeEventListener(PROJECT_ORDER_UPDATED_EVENT, handler as EventListener);
  });

  it("still dispatches the update event when the storage write itself fails", () => {
    const key = "write-key-3";
    const handler = vi.fn();
    window.addEventListener(PROJECT_ORDER_UPDATED_EVENT, handler as EventListener);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => writeProjectOrder(key, ["a", "b"])).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);

    spy.mockRestore();
    window.removeEventListener(PROJECT_ORDER_UPDATED_EVENT, handler as EventListener);
  });
});

describe("writeProjectSortMode", () => {
  it("persists a valid sort mode to localStorage", () => {
    const key = "sort-write-1";
    writeProjectSortMode(key, "recent");
    expect(localStorage.getItem(key)).toBe("recent");
  });

  it("normalizes an invalid sort mode to 'top' before writing", () => {
    const key = "sort-write-2";
    writeProjectSortMode(key, "bogus" as unknown as "top");
    expect(localStorage.getItem(key)).toBe("top");
  });

  it("dispatches a PROJECT_SORT_MODE_UPDATED_EVENT with the normalized mode", () => {
    const key = "sort-write-3";
    const handler = vi.fn();
    window.addEventListener(PROJECT_SORT_MODE_UPDATED_EVENT, handler as EventListener);

    writeProjectSortMode(key, "alphabetical");

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0] as CustomEvent<ProjectSortModeUpdatedDetail>;
    expect(event.detail).toEqual({ storageKey: key, sortMode: "alphabetical" });

    window.removeEventListener(PROJECT_SORT_MODE_UPDATED_EVENT, handler as EventListener);
  });

  it("still dispatches the update event when the storage write itself fails", () => {
    const key = "sort-write-4";
    const handler = vi.fn();
    window.addEventListener(PROJECT_SORT_MODE_UPDATED_EVENT, handler as EventListener);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => writeProjectSortMode(key, "recent")).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);

    spy.mockRestore();
    window.removeEventListener(PROJECT_SORT_MODE_UPDATED_EVENT, handler as EventListener);
  });
});

describe("sortProjectsByStoredOrder", () => {
  it("returns an empty array when there are no projects", () => {
    expect(sortProjectsByStoredOrder([], ["a", "b"])).toEqual([]);
  });

  it("returns the original list unchanged when no order is stored", () => {
    const projects = [makeProject("a"), makeProject("b")];
    expect(sortProjectsByStoredOrder(projects, [])).toBe(projects);
  });

  it("reorders projects to match the stored id order", () => {
    const a = makeProject("a");
    const b = makeProject("b");
    const c = makeProject("c");
    const sorted = sortProjectsByStoredOrder([a, b, c], ["c", "a", "b"]);
    expect(sorted.map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("appends projects missing from the stored order, preserving their relative order", () => {
    const a = makeProject("a");
    const b = makeProject("b");
    const c = makeProject("c");
    const sorted = sortProjectsByStoredOrder([a, b, c], ["c"]);
    expect(sorted.map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("ignores stored ids that no longer correspond to a known project", () => {
    const a = makeProject("a");
    const b = makeProject("b");
    const sorted = sortProjectsByStoredOrder([a, b], ["ghost", "b", "a"]);
    expect(sorted.map((p) => p.id)).toEqual(["b", "a"]);
  });
});
