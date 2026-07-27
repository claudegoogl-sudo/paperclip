/**
 * Bundling presets for Paperclip plugins.
 *
 * These helpers return plain config objects so plugin authors can use them
 * with esbuild or rollup without re-implementing host contract defaults.
 */

/**
 * Sourcemap mode accepted by the presets.
 *
 * `"external"` writes the `.map` next to the bundle but omits the
 * `//# sourceMappingURL=` footer, so a published `dist/` that excludes
 * `*.map` cannot leak the original TypeScript via `sourcesContent`.
 */
export type PluginSourcemapMode = boolean | "external" | "inline";

export type EsbuildSourcemap = boolean | "external" | "inline";
export type RollupSourcemap = boolean | "hidden" | "inline";

export interface PluginBundlerPresetInput {
  pluginRoot?: string;
  manifestEntry?: string;
  workerEntry?: string;
  uiEntry?: string;
  outdir?: string;
  sourcemap?: PluginSourcemapMode;
  minify?: boolean;
}

export interface EsbuildLikeOptions {
  entryPoints: string[];
  outdir: string;
  bundle: boolean;
  format: "esm";
  platform: "node" | "browser";
  target: string;
  sourcemap?: EsbuildSourcemap;
  minify?: boolean;
  external?: string[];
}

export interface RollupLikeConfig {
  input: string;
  output: {
    dir: string;
    format: "es";
    sourcemap?: RollupSourcemap;
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
 * Sourcemap mode the presets use when the caller does not pass one.
 */
export const DEFAULT_PLUGIN_SOURCEMAP: PluginSourcemapMode = "external";

/**
 * npm `files` negation that keeps `.map` files out of a published plugin tarball.
 */
export const PLUGIN_SOURCEMAP_FILES_NEGATION = "!dist/**/*.map";

/**
 * Recommended `files` allowlist for a plugin package.json — ships the built
 * bundles, keeps sourcemaps local-only.
 */
export const RECOMMENDED_PLUGIN_PACKAGE_FILES: readonly string[] = [
  "dist/",
  PLUGIN_SOURCEMAP_FILES_NEGATION,
  "README.md",
];

/** esbuild and rollup spell "map on disk, no footer" differently. */
function toRollupSourcemap(sourcemap: PluginSourcemapMode): RollupSourcemap {
  return sourcemap === "external" ? "hidden" : sourcemap;
}

/**
 * Build esbuild/rollup baseline configs for plugin worker, manifest, and UI bundles.
 *
 * The presets intentionally externalize host/runtime deps (`react`, SDK packages)
 * to match the Paperclip plugin loader contract.
 */
export function createPluginBundlerPresets(input: PluginBundlerPresetInput = {}): PluginBundlerPresets {
  const uiExternal = [
    "@paperclipai/plugin-sdk/ui",
    "@paperclipai/plugin-sdk/ui/hooks",
    "react",
    "react-dom",
    "react/jsx-runtime",
  ];

  const outdir = input.outdir ?? "dist";
  const workerEntry = input.workerEntry ?? "src/worker.ts";
  const manifestEntry = input.manifestEntry ?? "src/manifest.ts";
  const uiEntry = input.uiEntry;
  const sourcemap = input.sourcemap ?? DEFAULT_PLUGIN_SOURCEMAP;
  const rollupSourcemap = toRollupSourcemap(sourcemap);
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
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    sourcemap,
    external: ["@paperclipai/plugin-sdk"],
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
      sourcemap: rollupSourcemap,
      entryFileNames: "worker.js",
    },
    external: ["react", "react-dom"],
  };

  const rollupManifest: RollupLikeConfig = {
    input: manifestEntry,
    output: {
      dir: outdir,
      format: "es",
      sourcemap: rollupSourcemap,
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
        sourcemap: rollupSourcemap,
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
