import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addLease,
  emptyRegistry,
  isPortQuarantined,
  nextGeneration,
  ownedPorts,
  pruneExpiredReservations,
  quarantinePort,
  registryPathUnsafeReason,
  removeLeaseByHandle,
} from "./registry.js";
import type { BrokerRegistry, LeaseRecord } from "./types.js";

/** Build a minimal, valid lease record with overridable fields. */
function makeLease(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    handle: "handle-a",
    runtimeId: "runtime-a",
    peerUid: 1000,
    peerGid: 1000,
    ports: [42010],
    purposes: ["app"],
    state: "exposed",
    generation: 1,
    createdAtIso: "2026-08-14T00:00:00.000Z",
    expiresAtIso: null,
    ...overrides,
  };
}

describe("emptyRegistry", () => {
  it("builds a fresh registry with the given node identity and zeroed state", () => {
    expect(emptyRegistry("node-1")).toEqual({
      version: 1,
      nodeIdentity: "node-1",
      generationCounter: 0,
      leases: [],
      quarantinedPorts: [],
    });
  });
});

describe("nextGeneration", () => {
  it("increments the counter and returns the new value each call", () => {
    const registry = emptyRegistry("node-1");
    expect(nextGeneration(registry)).toBe(1);
    expect(nextGeneration(registry)).toBe(2);
    expect(nextGeneration(registry)).toBe(3);
    expect(registry.generationCounter).toBe(3);
  });
});

describe("addLease", () => {
  it("appends the lease to the registry's lease list", () => {
    const registry = emptyRegistry("node-1");
    const lease = makeLease();
    addLease(registry, lease);
    expect(registry.leases).toEqual([lease]);
  });

  it("does not dedupe by handle; multiple pushes all land", () => {
    const registry = emptyRegistry("node-1");
    const leaseA = makeLease({ handle: "handle-a" });
    const leaseB = makeLease({ handle: "handle-a", ports: [52010] });
    addLease(registry, leaseA);
    addLease(registry, leaseB);
    expect(registry.leases).toEqual([leaseA, leaseB]);
  });
});

describe("removeLeaseByHandle", () => {
  it("removes and returns the matching lease", () => {
    const registry = emptyRegistry("node-1");
    const leaseA = makeLease({ handle: "handle-a" });
    const leaseB = makeLease({ handle: "handle-b" });
    addLease(registry, leaseA);
    addLease(registry, leaseB);

    const removed = removeLeaseByHandle(registry, "handle-a");

    expect(removed).toEqual(leaseA);
    expect(registry.leases).toEqual([leaseB]);
  });

  it("returns null and leaves the registry untouched when no handle matches", () => {
    const registry = emptyRegistry("node-1");
    const lease = makeLease({ handle: "handle-a" });
    addLease(registry, lease);

    const removed = removeLeaseByHandle(registry, "no-such-handle");

    expect(removed).toBeNull();
    expect(registry.leases).toEqual([lease]);
  });

  it("removes only the first match when handles collide", () => {
    const registry = emptyRegistry("node-1");
    const first = makeLease({ handle: "dup", ports: [1] });
    const second = makeLease({ handle: "dup", ports: [2] });
    addLease(registry, first);
    addLease(registry, second);

    const removed = removeLeaseByHandle(registry, "dup");

    expect(removed).toEqual(first);
    expect(registry.leases).toEqual([second]);
  });
});

describe("pruneExpiredReservations", () => {
  function registryWith(leases: LeaseRecord[]): BrokerRegistry {
    const registry = emptyRegistry("node-1");
    registry.leases = leases;
    return registry;
  }

  it("removes reserved leases whose expiry is in the past and returns their ports", () => {
    const expired = makeLease({
      handle: "r1",
      state: "reserved",
      ports: [42010, 52010],
      expiresAtIso: "2026-08-14T00:00:00.000Z",
    });
    const registry = registryWith([expired]);

    const released = pruneExpiredReservations(registry, "2026-08-14T00:00:01.000Z");

    expect(released).toEqual([42010, 52010]);
    expect(registry.leases).toEqual([]);
  });

  it("treats an expiry exactly equal to now as expired", () => {
    const expired = makeLease({
      handle: "r1",
      state: "reserved",
      ports: [42010],
      expiresAtIso: "2026-08-14T00:00:00.000Z",
    });
    const registry = registryWith([expired]);

    const released = pruneExpiredReservations(registry, "2026-08-14T00:00:00.000Z");

    expect(released).toEqual([42010]);
    expect(registry.leases).toEqual([]);
  });

  it("keeps reserved leases whose expiry is still in the future", () => {
    const future = makeLease({
      handle: "r1",
      state: "reserved",
      ports: [42010],
      expiresAtIso: "2026-08-14T00:00:02.000Z",
    });
    const registry = registryWith([future]);

    const released = pruneExpiredReservations(registry, "2026-08-14T00:00:00.000Z");

    expect(released).toEqual([]);
    expect(registry.leases).toEqual([future]);
  });

  it("never prunes exposed leases, even with a past expiresAtIso", () => {
    const exposed = makeLease({
      handle: "e1",
      state: "exposed",
      ports: [42010],
      expiresAtIso: "2000-01-01T00:00:00.000Z",
    });
    const registry = registryWith([exposed]);

    const released = pruneExpiredReservations(registry, "2026-08-14T00:00:00.000Z");

    expect(released).toEqual([]);
    expect(registry.leases).toEqual([exposed]);
  });

  it("keeps a reserved lease with no expiresAtIso (unbounded)", () => {
    const unbounded = makeLease({ handle: "r1", state: "reserved", expiresAtIso: null });
    const registry = registryWith([unbounded]);

    const released = pruneExpiredReservations(registry, "2026-08-14T00:00:00.000Z");

    expect(released).toEqual([]);
    expect(registry.leases).toEqual([unbounded]);
  });

  it("keeps a reserved lease whose expiresAtIso does not parse", () => {
    const malformed = makeLease({
      handle: "r1",
      state: "reserved",
      expiresAtIso: "not-a-date",
    });
    const registry = registryWith([malformed]);

    const released = pruneExpiredReservations(registry, "2026-08-14T00:00:00.000Z");

    expect(released).toEqual([]);
    expect(registry.leases).toEqual([malformed]);
  });

  it("returns no released ports and leaves leases untouched when nowIso does not parse", () => {
    const expired = makeLease({
      handle: "r1",
      state: "reserved",
      ports: [42010],
      expiresAtIso: "2000-01-01T00:00:00.000Z",
    });
    const registry = registryWith([expired]);

    const released = pruneExpiredReservations(registry, "not-a-date");

    expect(released).toEqual([]);
    expect(registry.leases).toEqual([expired]);
  });
});

describe("isPortQuarantined / quarantinePort", () => {
  it("reports a port as not quarantined until it is added", () => {
    const registry = emptyRegistry("node-1");
    expect(isPortQuarantined(registry, 42010)).toBe(false);

    quarantinePort(registry, 42010);

    expect(isPortQuarantined(registry, 42010)).toBe(true);
    expect(registry.quarantinedPorts).toEqual([42010]);
  });

  it("does not add a duplicate entry when a port is already quarantined", () => {
    const registry = emptyRegistry("node-1");
    quarantinePort(registry, 42010);
    quarantinePort(registry, 42010);

    expect(registry.quarantinedPorts).toEqual([42010]);
  });
});

describe("ownedPorts", () => {
  it("collects the union of ports across all leases", () => {
    const registry = emptyRegistry("node-1");
    addLease(registry, makeLease({ handle: "a", ports: [42010, 52010] }));
    addLease(registry, makeLease({ handle: "b", ports: [42020] }));

    expect(ownedPorts(registry)).toEqual(new Set([42010, 52010, 42020]));
  });

  it("returns an empty set for a registry with no leases", () => {
    expect(ownedPorts(emptyRegistry("node-1"))).toEqual(new Set());
  });

  it("includes ports from reserved (not yet exposed) leases too", () => {
    const registry = emptyRegistry("node-1");
    addLease(registry, makeLease({ handle: "a", state: "reserved", ports: [42010] }));

    expect(ownedPorts(registry)).toEqual(new Set([42010]));
  });
});

describe("registryPathUnsafeReason", () => {
  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "registry-safety-"));
  }

  it("returns null when the parent directory does not exist yet", () => {
    const dir = tempDir();
    const missingParent = join(dir, "does-not-exist", "registry.json");
    expect(registryPathUnsafeReason(missingParent)).toBeNull();
  });

  it("returns null for a private (0700) directory with no registry file present", () => {
    const dir = tempDir();
    chmodSync(dir, 0o700);
    expect(registryPathUnsafeReason(join(dir, "registry.json"))).toBeNull();
  });

  it("flags a group/world writable parent directory", () => {
    const dir = tempDir();
    chmodSync(dir, 0o775);
    expect(registryPathUnsafeReason(join(dir, "registry.json"))).toBe(
      "registry parent directory is group/world writable",
    );
  });

  it("flags a group/world accessible registry file even when the directory is private", () => {
    const dir = tempDir();
    chmodSync(dir, 0o700);
    const path = join(dir, "registry.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o644);

    expect(registryPathUnsafeReason(path)).toBe("registry file is group/world accessible");
  });

  it("returns null for a private directory and a private (0600) registry file", () => {
    const dir = tempDir();
    chmodSync(dir, 0o700);
    const path = join(dir, "registry.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o600);

    expect(registryPathUnsafeReason(path)).toBeNull();
  });
});
