import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES } from "../constants.js";
import {
  pluginManagedRoutineDeclarationSchema,
  pluginManifestV1Schema,
  pluginUiSlotDeclarationSchema,
} from "./plugin.js";

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
      "routePath is only supported for page, routeSidebar, and companySettingsPage slots",
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

describe("plugin capability constants", () => {
  it("exposes each capability once", () => {
    expect(new Set(PLUGIN_CAPABILITIES).size).toBe(PLUGIN_CAPABILITIES.length);
  });
});

describe("plugin manifest validators", () => {
  it("accepts existing-style plugins that do not request access or authorization capabilities", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "paperclip.compat-dashboard",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Compat Dashboard",
      description: "Dashboard-only plugin without access or authorization host APIs.",
      author: "Paperclip",
      categories: ["ui"],
      capabilities: ["ui.dashboardWidget.register"],
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui.js",
      },
      ui: {
        slots: [
          {
            type: "dashboardWidget",
            id: "compat-dashboard",
            displayName: "Compat Dashboard",
            exportName: "CompatDashboard",
          },
        ],
      },
    });

    expect(parsed.capabilities).toEqual(["ui.dashboardWidget.register"]);
  });

  it("accepts sandbox provider template config bindings", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "paperclip.template-provider",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Template Provider",
      description: "Sandbox provider with captured template config binding.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["environment.drivers.register"],
      entrypoints: { worker: "./dist/worker.js" },
      environmentDrivers: [
        {
          driverKey: "template-provider",
          kind: "sandbox_provider",
          displayName: "Template Provider",
          supportsTemplateCapture: true,
          templateRefKind: "provider_template",
          templateConfigBinding: {
            field: "templateId",
            unsetFields: ["image"],
          },
          configSchema: { type: "object" },
        },
      ],
    });

    expect(parsed.environmentDrivers?.[0]?.templateConfigBinding).toEqual({
      field: "templateId",
      unsetFields: ["image"],
    });
  });

  it("rejects template config bindings that replace provider identity", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      id: "paperclip.bad-template-provider",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Bad Template Provider",
      categories: ["automation"],
      capabilities: ["environment.drivers.register"],
      entrypoints: { worker: "./dist/worker.js" },
      environmentDrivers: [
        {
          driverKey: "bad-template-provider",
          kind: "sandbox_provider",
          displayName: "Bad Template Provider",
          templateConfigBinding: {
            field: "provider",
          },
          configSchema: { type: "object" },
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("provider key"))).toBe(true);
  });
});

describe("plugin managed routine validators", () => {
  it("accepts core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.parse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      issueTemplate: { surfaceVisibility: "default" },
    });

    expect(parsed.issueTemplate?.surfaceVisibility).toBe("default");
  });

  it("rejects non-core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.safeParse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      issueTemplate: { surfaceVisibility: "normal" },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("plugin managed skill validators", () => {
  const baseManifest = {
    id: "paperclip.test-managed-skills",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Skills",
    description: "Managed skills test plugin.",
    author: "Paperclip",
    categories: ["automation"],
    entrypoints: { worker: "./dist/worker.js" },
  } as const;

  it("requires skills.managed when managed skills are declared", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: [],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("skills.managed"))).toBe(true);
  });

  it("accepts managed skills with the skills.managed capability", () => {
    const parsed = pluginManifestV1Schema.parse({
      ...baseManifest,
      capabilities: ["skills.managed"],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.skills?.[0]?.skillKey).toBe("wiki-maintainer");
  });
});

// Upstream v2026.525.0 added host-rendered support for `routeSidebar`,
// `detailTab`, `toolbarButton`, and `companySettingsPage` slots and shipped
// acceptance tests for them. Our fork's v1 host-rendered floor
// (PLUGIN_UI_SLOT_TYPES_V1_SUPPORTED = [dashboardWidget, page], PLA-122/123/489)
// is enforced on the SAME `pluginUiSlotDeclarationSchema`, so it still narrows
// install-time acceptance to dashboardWidget + page — these upstream slot types
// are rejected at the manifest validator until the floor is expanded.
//
// This describe block pins the fork's current (stricter) behavior. The
// floor-vs-upstream interaction is flagged to SecurityEngineer on PLA-623;
// flip these to acceptance assertions if/when the floor is widened to admit the
// upstream-rendered slot types. The upstream superRefine rules (routeSidebar
// requires routePath, reserved company route protection, companySettingsPage
// reserved-route shadowing) remain in plugin.ts as defense-in-depth and apply
// once a type clears the floor.
describe("plugin UI slot validators — gated by fork v1 floor", () => {
  it.each([
    "routeSidebar",
    "detailTab",
    "toolbarButton",
    "companySettingsPage",
  ])(
    "rejects upstream-expanded slot type %s under the v1 host-rendered floor",
    (slotType) => {
      const parsed = pluginUiSlotDeclarationSchema.safeParse({
        type: slotType,
        id: "x-slot",
        displayName: "X",
        exportName: "XSlot",
        routePath: "wiki",
        entityTypes: ["execution_workspace"],
      });

      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(
        parsed.error.issues.some((issue) =>
          issue.message.startsWith(`Invalid slot type "${slotType}"`),
        ),
      ).toBe(true);
    },
  );
});
