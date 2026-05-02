/**
 * Plugin bridge initialization.
 *
 * Registers the host's React instances and bridge hook implementations
 * on a global object so that the plugin module loader can inject them
 * into plugin UI bundles at load time.
 *
 * Call `initPluginBridge()` once during app startup (in `main.tsx`), before
 * any plugin UI modules are loaded.
 *
 * @see PLUGIN_SPEC.md §19.0.1 — Plugin UI SDK
 * @see PLUGIN_SPEC.md §19.0.2 — Bundle Isolation
 */

import {
  usePluginData,
  usePluginAction,
  useHostContext,
  usePluginStream,
  usePluginToast,
} from "./bridge.js";
import {
  ErrorBoundary,
  Spinner,
  StatusBadge,
} from "./sdk-ui-components.js";

// ---------------------------------------------------------------------------
// Global bridge registry
// ---------------------------------------------------------------------------

/**
 * The global bridge registry shape.
 *
 * This is placed on `globalThis.__paperclipPluginBridge__` and consumed by
 * the plugin module loader to provide implementations for external imports.
 */
export interface PluginBridgeRegistry {
  react: unknown;
  reactDom: unknown;
  sdkUi: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __paperclipPluginBridge__: PluginBridgeRegistry | undefined;
}

/**
 * Initialize the plugin bridge global registry.
 *
 * Registers the host's React, ReactDOM, and SDK UI bridge implementations
 * on `globalThis.__paperclipPluginBridge__` so the plugin module loader
 * can provide them to plugin bundles.
 *
 * @param react - The host's React module
 * @param reactDom - The host's ReactDOM module
 */
export function initPluginBridge(
  react: typeof import("react"),
  reactDom: typeof import("react-dom"),
): void {
  globalThis.__paperclipPluginBridge__ = {
    react,
    reactDom,
    sdkUi: {
      // Hooks — `@paperclipai/plugin-sdk/ui/hooks`.
      usePluginData,
      usePluginAction,
      useHostContext,
      usePluginStream,
      usePluginToast,
      // Components — `@paperclipai/plugin-sdk/ui/components`. To add another
      // SDK component, register it here and re-export it from the SDK
      // package's `components.ts`. The loader shim is general and discovers
      // names from this map at runtime, so no loader change is needed.
      Spinner,
      StatusBadge,
      ErrorBoundary,
    },
  };
}
