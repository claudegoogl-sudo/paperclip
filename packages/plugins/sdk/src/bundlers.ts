/**
 * Bundling presets for Paperclip plugins.
 *
 * These helpers return plain config objects so plugin authors can use them
 * with esbuild or rollup without re-implementing host contract defaults.
 */

export interface PluginBundlerPresetInput {
  pluginRoot?: string;
  manifestEntry?: string;
  workerEntry?: string;
  uiEntry?: string;
  outdir?: string;
  sourcemap?: boolean;
  minify?: boolean;
}

export interface EsbuildLikeOptions {
  entryPoints: string[];
  outdir: string;
  bundle: boolean;
  format: "esm";
  platform: "node" | "browser";
  target: string;
  sourcemap?: boolean;
  minify?: boolean;
  external?: string[];
}

export interface RollupLikeConfig {
  input: string;
  output: {
    dir: string;
    format: "es";
    sourcemap?: boolean;
    entryFileNames?: string;
  };
  external?: string[];
  plugins?: unknown[];
}

export interface PluginBundlerPresets {
  esbuild: {
    worker: EsbuildLikeOptions;
    ui?: EsbuildLikeOptions;
    manifest: EsbuildLikeOptions;
  };
  rollup: {
    worker: RollupLikeConfig;
    ui?: RollupLikeConfig;
    manifest: RollupLikeConfig;
  };
}

/**
 * Bare specifiers a plugin UI bundle MUST keep external.
 *
 * The host plugin loader rewrites these specifiers to the host-provided
 * implementations on the bridge registry (see `globalThis.__paperclipPluginBridge__`).
 * Bundling them into the plugin would either duplicate React (breaking hooks)
 * or shadow the host's SDK runtime so kit/hook calls would no longer reach the
 * host design tokens.
 *
 * Frozen so a regression — e.g. someone removing `/ui/components` from the
 * list — fails fast in tests rather than silently producing a bundle that
 * inlines the kit stubs and throws at render time.
 */
export const UI_BUNDLER_EXTERNALS: readonly string[] = Object.freeze([
  "@paperclipai/plugin-sdk/ui",
  "@paperclipai/plugin-sdk/ui/hooks",
  "@paperclipai/plugin-sdk/ui/components",
  "react",
  "react-dom",
  "react/jsx-runtime",
]);

/**
 * Build esbuild/rollup baseline configs for plugin worker, manifest, and UI bundles.
 *
 * The presets intentionally externalize host/runtime deps (`react`, SDK packages)
 * to match the Paperclip plugin loader contract.
 */
export function createPluginBundlerPresets(input: PluginBundlerPresetInput = {}): PluginBundlerPresets {
  const uiExternal = [...UI_BUNDLER_EXTERNALS];

  const outdir = input.outdir ?? "dist";
  const workerEntry = input.workerEntry ?? "src/worker.ts";
  const manifestEntry = input.manifestEntry ?? "src/manifest.ts";
  const uiEntry = input.uiEntry;
  const sourcemap = input.sourcemap ?? true;
  const minify = input.minify ?? false;

  const esbuildWorker: EsbuildLikeOptions = {
    entryPoints: [workerEntry],
    outdir,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    sourcemap,
    minify,
    external: ["react", "react-dom"],
  };

  const esbuildManifest: EsbuildLikeOptions = {
    entryPoints: [manifestEntry],
    outdir,
    bundle: false,
    format: "esm",
    platform: "node",
    target: "node20",
    sourcemap,
  };

  const esbuildUi = uiEntry
    ? {
      entryPoints: [uiEntry],
      outdir: `${outdir}/ui`,
      bundle: true,
      format: "esm" as const,
      platform: "browser" as const,
      target: "es2022",
      sourcemap,
      minify,
      external: uiExternal,
    }
    : undefined;

  const rollupWorker: RollupLikeConfig = {
    input: workerEntry,
    output: {
      dir: outdir,
      format: "es",
      sourcemap,
      entryFileNames: "worker.js",
    },
    external: ["react", "react-dom"],
  };

  const rollupManifest: RollupLikeConfig = {
    input: manifestEntry,
    output: {
      dir: outdir,
      format: "es",
      sourcemap,
      entryFileNames: "manifest.js",
    },
    external: ["@paperclipai/plugin-sdk"],
  };

  const rollupUi = uiEntry
    ? {
      input: uiEntry,
      output: {
        dir: `${outdir}/ui`,
        format: "es" as const,
        sourcemap,
        entryFileNames: "index.js",
      },
      external: uiExternal,
    }
    : undefined;

  return {
    esbuild: {
      worker: esbuildWorker,
      manifest: esbuildManifest,
      ...(esbuildUi ? { ui: esbuildUi } : {}),
    },
    rollup: {
      worker: rollupWorker,
      manifest: rollupManifest,
      ...(rollupUi ? { ui: rollupUi } : {}),
    },
  };
}
