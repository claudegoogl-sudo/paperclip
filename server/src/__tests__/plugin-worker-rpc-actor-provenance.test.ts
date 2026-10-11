import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { HostToWorkerMethods } from "@paperclipai/plugin-sdk";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import {
  getActorProvenance,
  runWithActorProvenance,
  type ActorProvenance,
} from "../middleware/actor-context.js";
import { persistActivity } from "../services/activity-log.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "plugin-worker-provenance-probe.cjs",
);

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

// Minimal Db stand-in: captures the activity_log insert values so we assert
// exactly what `persistActivity` would write for actor_source / actor_key_id.
function captureDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const chain = (rows: unknown[]) => {
    const p: any = Promise.resolve(rows);
    p.from = () => p;
    p.where = () => p;
    p.limit = () => p;
    p.innerJoin = () => p;
    p.leftJoin = () => p;
    return p;
  };
  const db: any = {
    select: () => chain([]),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: async () => [{ id: randomUUID() }] };
      },
    }),
  };
  return { db, inserted };
}

async function runProbe(
  mode: "valid" | "none" | "bogus",
  provenance: ActorProvenance,
  startInsideRequest = false,
) {
  const observed: Array<ActorProvenance | null> = [];
  const { db, inserted } = captureDb();
  const probe = vi.fn(async () => {
    observed.push(getActorProvenance());
    await persistActivity(db, {
      companyId: "company-a",
      actorType: "plugin",
      actorId: "test.plugin",
      action: "plugin.probe",
      entityType: "plugin",
      entityId: "test.plugin",
    } as never);
    return { ok: true };
  });
  const handle = createPluginWorkerHandle("test.plugin", {
    entrypointPath: FIXTURE,
    manifest: TEST_MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: { "probe.provenance": probe } as never,
    env: { PROVENANCE_ECHO_MODE: mode },
  });
  try {
    // A worker may be spawned lazily from inside a request; its stdout listener
    // then inherits that request's ALS context. Both shapes are exercised.
    if (startInsideRequest) await runWithActorProvenance(provenance, () => handle.start());
    else await handle.start();
    // The dispatch is issued inside the originating request's provenance scope,
    // exactly as a board-gated plugin dispatch route would.
    await runWithActorProvenance(provenance, () =>
      handle.call("onEvent", {
        event: { companyId: "company-a", type: "issue.created" },
      } as unknown as HostToWorkerMethods["onEvent"][0]),
    );
  } finally {
    await handle.stop().catch(() => undefined);
  }
  expect(probe).toHaveBeenCalledTimes(1);
  return { observed: observed[0], row: inserted[0] };
}

describe.each([
  ["worker started outside any request", false],
  ["worker spawned inside a board-key request", true],
])("board-key provenance across the plugin worker→host RPC boundary (%s)", (_label, startInside) => {
  const boardKey: ActorProvenance = { source: "board_key", keyId: randomUUID() };

  it("binds the originating request's provenance when the worker echoes the host-minted invocation id", async () => {
    const { observed, row } = await runProbe("valid", boardKey, startInside);
    expect(observed).toEqual(boardKey);
    expect(row).toMatchObject({ actorSource: "board_key", actorKeyId: boardKey.keyId });
  });

  it("records NULL for an id-less call even when exactly one invocation is in flight (singleInFlightScope must not feed provenance)", async () => {
    const { observed, row } = await runProbe("none", boardKey, startInside);
    expect(observed).toBeNull();
    expect(row).toMatchObject({ actorSource: null, actorKeyId: null });
  });

  it("records NULL when the echoed invocation id is unknown or expired", async () => {
    const { observed, row } = await runProbe("bogus", boardKey, startInside);
    expect(observed).toBeNull();
    expect(row).toMatchObject({ actorSource: null, actorKeyId: null });
  });
});
