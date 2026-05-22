import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "./plugin.js";

/**
 * v1 manifest UI slot floor (PLA-122 / PLA-123 / PLA-489): the host mounts
 * `dashboardWidget` and `page` in v1. Other `PLUGIN_UI_SLOT_TYPES` values
 * remain reserved-but-unrendered, so the manifest validator must reject them
 * at install time with a message that names the supported set.
 */

function manifestWithSlot(slot: Record<string, unknown>): unknown {
  return {
    id: "test.plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "Manifest fixture for slot validator coverage.",
    author: "Test",
    categories: ["ui"],
    capabilities: ["issues.read"],
    entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui.js" },
    ui: { slots: [slot] },
  };
}

function manifestWithSlotType(type: string): unknown {
  return manifestWithSlot({
    type,
    id: "widget",
    displayName: "Widget",
    exportName: "Widget",
  });
}

describe("plugin manifest UI slot type — v1 floor", () => {
  it("accepts dashboardWidget as a v1 host-rendered slot type", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifestWithSlotType("dashboardWidget"),
    );
    expect(result.success).toBe(true);
  });

  it("accepts page as a v1 host-rendered slot type when routePath is a valid slug", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifestWithSlot({
        type: "page",
        id: "main",
        displayName: "Main Page",
        exportName: "MainPage",
        routePath: "klipper",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a page slot without a routePath (host falls back to pluginId routing)", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifestWithSlot({
        type: "page",
        id: "main",
        displayName: "Main Page",
        exportName: "MainPage",
      }),
    );
    expect(result.success).toBe(true);
  });

  // Reserved (planned but not yet host-rendered in v1). Limited to the slot
  // types whose only failure mode is the v1 floor — entity-scoped slots have
  // additional superRefine rules that would muddy the assertion.
  it.each([
    "sidebar",
    "sidebarPanel",
    "globalToolbarButton",
    "toolbarButton",
    "settingsPage",
  ])(
    "rejects reserved slot type %s with a message naming the v1 supported set",
    (slotType) => {
      const result = pluginManifestV1Schema.safeParse(
        manifestWithSlotType(slotType),
      );
      expect(result.success).toBe(false);
      if (result.success) return;
      const slotTypeIssue = result.error.errors.find(
        (issue) => issue.path.join(".") === "ui.slots.0.type",
      );
      expect(slotTypeIssue).toBeDefined();
      expect(slotTypeIssue?.message).toBe(
        `Invalid slot type "${slotType}". v1 supports: dashboardWidget, page`,
      );
    },
  );

  it("rejects an unknown slot type with the standard enum error", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifestWithSlotType("not-a-real-slot-type"),
    );
    expect(result.success).toBe(false);
  });

  it("rejects routePath on a non-page slot (page-only contract still enforced)", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifestWithSlot({
        type: "dashboardWidget",
        id: "widget",
        displayName: "Widget",
        exportName: "Widget",
        routePath: "dashboard",
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const routePathIssue = result.error.errors.find(
      (issue) => issue.path.join(".") === "ui.slots.0.routePath",
    );
    expect(routePathIssue?.message).toBe(
      "routePath is only supported for page slots",
    );
  });

  it("rejects a page slot whose routePath is not a valid slug", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifestWithSlot({
        type: "page",
        id: "main",
        displayName: "Main Page",
        exportName: "MainPage",
        routePath: "Not A Slug",
      }),
    );
    expect(result.success).toBe(false);
  });
});
