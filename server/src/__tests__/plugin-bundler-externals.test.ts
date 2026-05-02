/**
 * Confirms that the plugin SDK bundler presets externalise the host-provided
 * subpaths a plugin UI bundle MUST keep external — including
 * `@paperclipai/plugin-sdk/ui/components`, which the host plugin loader rewrites
 * to the registered host kit at runtime (Spinner / StatusBadge / ErrorBoundary).
 *
 * If a regression accidentally removes one of these from the externals list,
 * `createPluginBundlerPresets()` would emit a UI bundle that inlines the SDK
 * kit factory stubs — those stubs throw at render time because they expect
 * `globalThis.__paperclipPluginBridge__.sdkUi[name]` to be the host
 * implementation. This test fails fast on that regression.
 *
 * @see PLA-118 — externalise `@paperclipai/plugin-sdk/ui/components`.
 */
import { describe, expect, it } from "vitest";
import {
  UI_BUNDLER_EXTERNALS,
  createPluginBundlerPresets,
} from "../../../packages/plugins/sdk/src/bundlers.js";

const REQUIRED_HOST_SUBPATHS = [
  "@paperclipai/plugin-sdk/ui",
  "@paperclipai/plugin-sdk/ui/hooks",
  "@paperclipai/plugin-sdk/ui/components",
] as const;

const REQUIRED_REACT_EXTERNALS = ["react", "react-dom", "react/jsx-runtime"] as const;

describe("plugin bundler UI externals", () => {
  it("includes every host-provided SDK subpath in the canonical list", () => {
    for (const subpath of REQUIRED_HOST_SUBPATHS) {
      expect(UI_BUNDLER_EXTERNALS).toContain(subpath);
    }
  });

  it("includes the React peer deps in the canonical list", () => {
    for (const dep of REQUIRED_REACT_EXTERNALS) {
      expect(UI_BUNDLER_EXTERNALS).toContain(dep);
    }
  });

  it("freezes the canonical externals list to prevent mutation", () => {
    expect(Object.isFrozen(UI_BUNDLER_EXTERNALS)).toBe(true);
  });

  it("emits the canonical externals list on the esbuild UI preset", () => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
    expect(presets.esbuild.ui).toBeDefined();
    for (const subpath of REQUIRED_HOST_SUBPATHS) {
      expect(presets.esbuild.ui!.external).toContain(subpath);
    }
  });

  it("emits the canonical externals list on the rollup UI preset", () => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
    expect(presets.rollup.ui).toBeDefined();
    for (const subpath of REQUIRED_HOST_SUBPATHS) {
      expect(presets.rollup.ui!.external).toContain(subpath);
    }
  });

  it("does not emit a UI preset when no UI entry is supplied", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.ui).toBeUndefined();
    expect(presets.rollup.ui).toBeUndefined();
  });
});
