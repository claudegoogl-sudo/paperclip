import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1, PluginEvent } from "@paperclipai/plugin-sdk";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  type HostServices,
  type HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { eventTypeForActivityAction } from "../services/activity-log.js";

// `issue.attachment.created` gives a media-relay plugin an in-scope trigger for
// late-uploaded comment media. These tests cover: the event type + activity
// mapping, that a handler for it can call issues.listAttachments inside the
// event's company scope, and that the company boundary holds.

const ENTRYPOINT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "plugin-worker-onevent-request.cjs",
);

const MANIFEST = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["issue.attachments.read"],
  entrypoints: { worker: "dist/worker.js" },
} as unknown as PaperclipPluginManifestV1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const listAttachments = vi.fn(async () => [{ id: "att-1", assetId: "asset-1" }]);
  const handlers = createHostClientHandlers({
    pluginId: "test.plugin",
    capabilities: ["issue.attachments.read"],
    services: { issues: { listAttachments } } as unknown as HostServices,
  });
  const handle = createPluginWorkerHandle("test.plugin", {
    entrypointPath: ENTRYPOINT,
    manifest: MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: handlers,
    env: { PLUGIN_FIXTURE_ECHOES_INVOCATION_ID: "1" },
  });
  return { handle, listAttachments };
}

const attachmentEvent = (companyId: string, payload: Record<string, unknown> = {}) =>
  ({
    event: {
      companyId,
      type: "attach-list",
      eventType: "issue.attachment.created",
      payload: { issueId: "issue-1", attachmentId: "att-1", commentId: null, ...payload },
    },
  }) as unknown as HostToWorkerMethods["onEvent"][0];

describe("issue.attachment.created plugin event", () => {
  it("is a declared plugin event type mapped from both attachment activity actions", () => {
    expect(PLUGIN_EVENT_TYPES).toContain("issue.attachment.created");
    expect(eventTypeForActivityAction("issue.attachment_added")).toBe("issue.attachment.created");
    expect(eventTypeForActivityAction("issue.attachment_bound")).toBe("issue.attachment.created");
    // Removal is not an "attachment created" signal.
    expect(eventTypeForActivityAction("issue.attachment_removed")).toBeNull();
  });

  it("a handler for the event can call issues.listAttachments in the event's company scope", async () => {
    const h = harness();
    try {
      await h.handle.start();
      h.handle.notify("onEvent", attachmentEvent("company-a"));
      await sleep(300);
      expect(h.listAttachments).toHaveBeenCalledTimes(1);
      expect(h.listAttachments.mock.calls[0]![0]).toMatchObject({ issueId: "issue-1", companyId: "company-a" });
    } finally {
      await h.handle.stop().catch(() => undefined);
    }
  });

  it("company boundary: the handler cannot read another company's attachments from the event's scope", async () => {
    const h = harness();
    try {
      await h.handle.start();
      h.handle.notify("onEvent", attachmentEvent("company-a", { probeCompanyId: "company-b" }));
      await sleep(300);
      expect(h.listAttachments).not.toHaveBeenCalled();
    } finally {
      await h.handle.stop().catch(() => undefined);
    }
  });

  it("company boundary: a company-filtered subscription only gets its own company's attachment events", async () => {
    const bus = createPluginEventBus();
    const seen: string[] = [];
    bus.forPlugin("test.plugin").subscribe(
      "issue.attachment.created",
      { companyId: "company-a" },
      async (event: PluginEvent) => {
        seen.push(event.companyId);
      },
    );
    const base = {
      eventType: "issue.attachment.created" as const,
      occurredAt: new Date().toISOString(),
      actorType: "user" as const,
      actorId: "u",
      entityType: "issue",
      entityId: "issue-1",
    };
    await bus.emit({ ...base, eventId: "e1", companyId: "company-a", payload: { attachmentId: "a" } });
    await bus.emit({ ...base, eventId: "e2", companyId: "company-b", payload: { attachmentId: "b" } });
    expect(seen).toEqual(["company-a"]);
  });
});
