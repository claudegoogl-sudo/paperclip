#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALID_TEMPLATES = ["default", "connector", "workspace", "environment"] as const;
type PluginTemplate = (typeof VALID_TEMPLATES)[number];
const VALID_CATEGORIES = new Set(["connector", "workspace", "automation", "ui", "environment"] as const);

export interface ScaffoldPluginOptions {
  pluginName: string;
  outputDir: string;
  template?: PluginTemplate;
  displayName?: string;
  description?: string;
  author?: string;
  category?: "connector" | "workspace" | "automation" | "ui" | "environment";
  sdkPath?: string;
}

/** Validate npm-style plugin package names (scoped or unscoped). */
export function isValidPluginName(name: string): boolean {
  const scopedPattern = /^@[a-z0-9_-]+\/[a-z0-9._-]+$/;
  const unscopedPattern = /^[a-z0-9._-]+$/;
  return scopedPattern.test(name) || unscopedPattern.test(name);
}

/** Convert `@scope/name` to an output directory basename (`name`). */
function packageToDirName(pluginName: string): string {
  return pluginName.replace(/^@[^/]+\//, "");
}

/** Convert an npm package name into a manifest-safe plugin id. */
function packageToManifestId(pluginName: string): string {
  if (!pluginName.startsWith("@")) {
    return pluginName;
  }

  return pluginName.slice(1).replace("/", ".");
}

/** Build a human-readable display name from package name tokens. */
function makeDisplayName(pluginName: string): string {
  const raw = packageToDirName(pluginName).replace(/[._-]+/g, " ").trim();
  return raw
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function writeFile(target: string, content: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function formatFileDependency(absPath: string): string {
  return `file:${toPosixPath(path.resolve(absPath))}`;
}

function getLocalSdkPackagePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "sdk");
}

function getRepoRootFromSdkPath(sdkPath: string): string {
  return path.resolve(sdkPath, "..", "..", "..");
}

function getLocalSharedPackagePath(sdkPath: string): string {
  return path.resolve(getRepoRootFromSdkPath(sdkPath), "packages", "shared");
}

function isInsideDir(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function packLocalPackage(packagePath: string, outputDir: string): string {
  const packageJsonPath = path.join(packagePath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Package package.json not found at ${packageJsonPath}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
    version?: string;
  };
  const packageName = packageJson.name ?? path.basename(packagePath);
  const packageVersion = packageJson.version ?? "0.0.0";
  const tarballFileName = `${packageName.replace(/^@/, "").replace("/", "-")}-${packageVersion}.tgz`;
  const sdkBundleDir = path.join(outputDir, ".paperclip-sdk");

  fs.mkdirSync(sdkBundleDir, { recursive: true });
  execFileSync("pnpm", ["build"], { cwd: packagePath, stdio: "pipe" });
  execFileSync("pnpm", ["pack", "--pack-destination", sdkBundleDir], { cwd: packagePath, stdio: "pipe" });

  const tarballPath = path.join(sdkBundleDir, tarballFileName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Packed tarball was not created at ${tarballPath}`);
  }

  return tarballPath;
}

/**
 * Generate a complete Paperclip plugin starter project.
 *
 * Output includes manifest/worker/UI entries, SDK harness tests, bundler presets,
 * and a local dev server script for hot-reload workflow.
 */
export function scaffoldPluginProject(options: ScaffoldPluginOptions): string {
  const template = options.template ?? "default";
  if (!VALID_TEMPLATES.includes(template)) {
    throw new Error(`Invalid template '${template}'. Expected one of: ${VALID_TEMPLATES.join(", ")}`);
  }

  if (!isValidPluginName(options.pluginName)) {
    throw new Error("Invalid plugin name. Must be lowercase and may include scope, dots, underscores, or hyphens.");
  }

  if (options.category && !VALID_CATEGORIES.has(options.category)) {
    throw new Error(`Invalid category '${options.category}'. Expected one of: ${[...VALID_CATEGORIES].join(", ")}`);
  }

  const outputDir = path.resolve(options.outputDir);
  if (fs.existsSync(outputDir)) {
    throw new Error(`Directory already exists: ${outputDir}`);
  }

  const displayName = options.displayName ?? makeDisplayName(options.pluginName);
  const description = options.description ?? "A Paperclip plugin";
  const author = options.author ?? "Plugin Author";
  const category = options.category ?? (template === "workspace" ? "workspace" : template === "environment" ? "environment" : "connector");
  const manifestId = packageToManifestId(options.pluginName);
  const localSdkPath = path.resolve(options.sdkPath ?? getLocalSdkPackagePath());
  const localSharedPath = getLocalSharedPackagePath(localSdkPath);
  const repoRoot = getRepoRootFromSdkPath(localSdkPath);
  const useWorkspaceSdk = isInsideDir(outputDir, repoRoot);

  fs.mkdirSync(outputDir, { recursive: true });

  const packedSharedTarball = useWorkspaceSdk ? null : packLocalPackage(localSharedPath, outputDir);
  const sdkDependency = useWorkspaceSdk
    ? "workspace:*"
    : `file:${toPosixPath(path.relative(outputDir, packLocalPackage(localSdkPath, outputDir)))}`;

  const packageJson = {
    name: options.pluginName,
    version: "0.1.0",
    type: "module",
    private: true,
    description,
    scripts: {
      build: "node ./esbuild.config.mjs",
      "build:rollup": "rollup -c",
      dev: "node ./esbuild.config.mjs --watch",
      "dev:ui": "paperclip-plugin-dev-server --root . --ui-dir dist/ui --port 4177",
      test: "vitest run --config ./vitest.config.ts",
      typecheck: "tsc --noEmit",
      // PLA-376 — release-time plugin manifest validation gate. Runs the
      // host plugin-manifest validator against `dist/manifest.js` so a
      // tarball cannot be packed/published with a manifest the host will
      // reject at install time. See `scripts/validate-manifest.mjs`.
      "validate:manifest": "node ./scripts/validate-manifest.mjs",
      prepack: "npm run build && npm run validate:manifest"
    },
    paperclipPlugin: {
      manifest: "./dist/manifest.js",
      worker: "./dist/worker.js",
      ui: "./dist/ui/"
    },
    keywords: ["paperclip", "plugin", category],
    author,
    license: "MIT",
    ...(packedSharedTarball
      ? {
        pnpm: {
          overrides: {
            "@paperclipai/shared": `file:${toPosixPath(path.relative(outputDir, packedSharedTarball))}`,
          },
        },
      }
      : {}),
    devDependencies: {
      // PLA-376: `@paperclipai/shared` is a release-gate dep — the
      // scaffolded `scripts/validate-manifest.mjs` imports
      // `pluginManifestV1Schema` from it. We resolve it the same way as
      // the SDK: `workspace:*` for in-workspace scaffolds, packed
      // tarball file: dep otherwise. The two modes are mutually
      // exclusive (see `packedSharedTarball` initialization above), so
      // every scaffolded plugin gets a concrete dep — no implicit `*`.
      "@paperclipai/shared": useWorkspaceSdk
        ? "workspace:*"
        : `file:${toPosixPath(path.relative(outputDir, packedSharedTarball!))}`,
      "@paperclipai/plugin-sdk": sdkDependency,
      "@rollup/plugin-node-resolve": "^16.0.1",
      "@rollup/plugin-typescript": "^12.1.2",
      "@types/node": "^24.6.0",
      "@types/react": "^19.0.8",
      esbuild: "^0.27.3",
      rollup: "^4.38.0",
      tslib: "^2.8.1",
      typescript: "^5.7.3",
      vitest: "^3.0.5"
    },
    peerDependencies: {
      react: ">=18"
    }
  };

  writeFile(path.join(outputDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM"],
      jsx: "react-jsx",
      strict: true,
      skipLibCheck: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      outDir: "dist",
      rootDir: "."
    },
    include: ["src", "tests"],
    exclude: ["dist", "node_modules"]
  };

  writeFile(path.join(outputDir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);

  writeFile(
    path.join(outputDir, "esbuild.config.mjs"),
    `import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(presets.esbuild.ui);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
`,
  );

  writeFile(
    path.join(outputDir, "rollup.config.mjs"),
    `import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });

function withPlugins(config) {
  if (!config) return null;
  return {
    ...config,
    plugins: [
      nodeResolve({
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
      }),
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: false,
        declarationMap: false,
      }),
    ],
  };
}

export default [
  withPlugins(presets.rollup.manifest),
  withPlugins(presets.rollup.worker),
  withPlugins(presets.rollup.ui),
].filter(Boolean);
`,
  );

  writeFile(
    path.join(outputDir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});
`,
  );

  if (template === "environment") {
    writeFile(
      path.join(outputDir, "src", "manifest.ts"),
      `import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: ${quote(manifestId)},
  apiVersion: 1,
  version: "0.1.0",
  displayName: ${quote(displayName)},
  description: ${quote(description)},
  author: ${quote(author)},
  categories: [${quote(category)}],
  capabilities: [
    "environment.drivers.register",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  environmentDrivers: [
    {
      driverKey: ${quote(manifestId + "-driver")},
      displayName: ${quote(displayName + " Driver")}
    }
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: ${quote(`${displayName} Health`)},
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
`,
    );

    writeFile(
      path.join(outputDir, "src", "worker.ts"),
      `import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentProbeParams,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentExecuteParams,
} from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("health", async () => {
      return { status: "ok", checkedAt: new Date().toISOString() };
    });
  },

  async onHealth() {
    return { status: "ok", message: "Environment plugin worker is running" };
  },

  async onEnvironmentValidateConfig(params: PluginEnvironmentValidateConfigParams) {
    if (!params.config || typeof params.config !== "object") {
      return { ok: false, errors: ["Config must be a non-null object"] };
    }
    return { ok: true, normalizedConfig: params.config };
  },

  async onEnvironmentProbe(_params: PluginEnvironmentProbeParams) {
    return { ok: true, summary: "Environment is reachable" };
  },

  async onEnvironmentAcquireLease(params: PluginEnvironmentAcquireLeaseParams) {
    const providerLeaseId = \`lease-\${params.runId}-\${Date.now()}\`;
    return {
      providerLeaseId,
      metadata: { acquiredAt: new Date().toISOString() },
    };
  },

  async onEnvironmentResumeLease(params: PluginEnvironmentResumeLeaseParams) {
    return {
      providerLeaseId: params.providerLeaseId,
      metadata: { ...params.leaseMetadata, resumed: true },
    };
  },

  async onEnvironmentReleaseLease(_params: PluginEnvironmentReleaseLeaseParams) {
    // Release provider-side resources here
  },

  async onEnvironmentDestroyLease(_params: PluginEnvironmentDestroyLeaseParams) {
    // Destroy provider-side resources here
  },

  async onEnvironmentRealizeWorkspace(params: PluginEnvironmentRealizeWorkspaceParams) {
    const cwd = params.workspace.remotePath ?? params.workspace.localPath ?? "/tmp/workspace";
    return { cwd, metadata: { realized: true } };
  },

  async onEnvironmentExecute(params: PluginEnvironmentExecuteParams) {
    // Replace this with real command execution against your provider
    return {
      exitCode: 0,
      timedOut: false,
      stdout: \`Executed: \${params.command}\`,
      stderr: "",
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
`,
    );

    writeFile(
      path.join(outputDir, "src", "ui", "index.tsx"),
      `import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

type HealthData = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
};

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");

  if (loading) return <div>Loading environment health...</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <strong>${displayName}</strong>
      <div>Health: {data?.status ?? "unknown"}</div>
      <div>Checked: {data?.checkedAt ?? "never"}</div>
    </div>
  );
}
`,
    );

    writeFile(
      path.join(outputDir, "tests", "plugin.spec.ts"),
      `import { describe, expect, it } from "vitest";
import {
  createEnvironmentTestHarness,
  createFakeEnvironmentDriver,
  assertEnvironmentEventOrder,
  assertLeaseLifecycle,
} from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const ENV_ID = "env-test-1";
const BASE_PARAMS = {
  driverKey: manifest.environmentDrivers![0].driverKey,
  companyId: "co-1",
  environmentId: ENV_ID,
  config: {},
};

describe("environment plugin scaffold", () => {
  it("declares capabilities for its manifest features", () => {
    expect(manifest.capabilities).toContain("environment.drivers.register");
    expect(manifest.capabilities).toContain("ui.dashboardWidget.register");
  });

  it("validates config", async () => {
    const driver = createFakeEnvironmentDriver({ driverKey: BASE_PARAMS.driverKey });
    const harness = createEnvironmentTestHarness({ manifest, environmentDriver: driver });
    await plugin.definition.setup(harness.ctx);

    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: BASE_PARAMS.driverKey,
      config: { host: "test" },
    });
    expect(result.ok).toBe(true);
  });

  it("probes the environment", async () => {
    const driver = createFakeEnvironmentDriver({ driverKey: BASE_PARAMS.driverKey });
    const harness = createEnvironmentTestHarness({ manifest, environmentDriver: driver });
    await plugin.definition.setup(harness.ctx);

    const result = await plugin.definition.onEnvironmentProbe!(BASE_PARAMS);
    expect(result.ok).toBe(true);
  });

  it("runs a full lease lifecycle through the harness", async () => {
    const driver = createFakeEnvironmentDriver({ driverKey: BASE_PARAMS.driverKey });
    const harness = createEnvironmentTestHarness({ manifest, environmentDriver: driver });
    await plugin.definition.setup(harness.ctx);

    const lease = await harness.acquireLease({ ...BASE_PARAMS, runId: "run-1" });
    expect(lease.providerLeaseId).toBeTruthy();

    await harness.realizeWorkspace({
      ...BASE_PARAMS,
      lease,
      workspace: { localPath: "/tmp/test" },
    });

    await harness.releaseLease({
      ...BASE_PARAMS,
      providerLeaseId: lease.providerLeaseId,
    });

    assertEnvironmentEventOrder(harness.environmentEvents, [
      "acquireLease",
      "realizeWorkspace",
      "releaseLease",
    ]);
    assertLeaseLifecycle(harness.environmentEvents, ENV_ID);
  });
});
`,
    );
  } else {
    writeFile(
      path.join(outputDir, "src", "manifest.ts"),
      `import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: ${quote(manifestId)},
  apiVersion: 1,
  version: "0.1.0",
  displayName: ${quote(displayName)},
  description: ${quote(description)},
  author: ${quote(author)},
  categories: [${quote(category)}],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: ${quote(`${displayName} Health`)},
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
`,
    );

    writeFile(
      path.join(outputDir, "src", "worker.ts"),
      `import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.events.on("issue.created", async (event) => {
      const issueId = event.entityId ?? "unknown";
      await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: "seen" }, true);
      ctx.logger.info("Observed issue.created", { issueId });
    });

    ctx.data.register("health", async () => {
      return { status: "ok", checkedAt: new Date().toISOString() };
    });

    ctx.actions.register("ping", async () => {
      ctx.logger.info("Ping action invoked");
      return { pong: true, at: new Date().toISOString() };
    });
  },

  async onHealth() {
    return { status: "ok", message: "Plugin worker is running" };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
`,
    );

    writeFile(
      path.join(outputDir, "src", "ui", "index.tsx"),
      `import { usePluginAction, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

type HealthData = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
};

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");
  const ping = usePluginAction("ping");

  if (loading) return <div>Loading plugin health...</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <strong>${displayName}</strong>
      <div>Health: {data?.status ?? "unknown"}</div>
      <div>Checked: {data?.checkedAt ?? "never"}</div>
      <button onClick={() => void ping()}>Ping Worker</button>
    </div>
  );
}
`,
    );

    writeFile(
      path.join(outputDir, "tests", "plugin.spec.ts"),
      `import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("plugin scaffold", () => {
  it("declares capabilities for its manifest features", () => {
    expect(manifest.capabilities).toContain("events.subscribe");
    expect(manifest.capabilities).toContain("ui.dashboardWidget.register");
  });

  it("registers data + actions and handles events", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.emit("issue.created", { issueId: "iss_1" }, { entityId: "iss_1", entityType: "issue" });
    expect(harness.getState({ scopeKind: "issue", scopeId: "iss_1", stateKey: "seen" })).toBe(true);

    const data = await harness.getData<{ status: string }>("health");
    expect(data.status).toBe("ok");

    const action = await harness.performAction<{ pong: boolean }>("ping");
    expect(action.pong).toBe(true);
  });
});
`,
    );
  }

  writeFile(
    path.join(outputDir, "README.md"),
    `# ${displayName}

${description}

## Development

\`\`\`bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
\`\`\`

\`pnpm dev\` rebuilds the worker, manifest, and UI bundles into \`dist/\`.
When this package is installed from a local path, Paperclip watches that rebuilt
output and reloads the plugin worker. Local installs run trusted code from this
folder on your machine.

${sdkDependency.startsWith("file:")
  ? `This scaffold snapshots \`@paperclipai/plugin-sdk\` and \`@paperclipai/shared\` from a local Paperclip checkout at:\n\n\`${toPosixPath(localSdkPath)}\`\n\nThe packed tarballs live in \`.paperclip-sdk/\` for local development. Before publishing this plugin, switch those dependencies to published package versions once they are available on npm.\n\n`
  : ""}

## Install Into Paperclip

\`\`\`bash
paperclipai plugin install ${shellQuote(toPosixPath(outputDir))}
\`\`\`

## Build Options

- \`pnpm build\` uses esbuild presets from \`@paperclipai/plugin-sdk/bundlers\`.
- \`pnpm build:rollup\` uses rollup presets from the same SDK.
`,
  );

  writeFile(path.join(outputDir, ".gitignore"), "dist\nnode_modules\n.paperclip-sdk\n");

  // ── PLA-376 release-time manifest validation gate ──────────────────────
  // Every scaffolded plugin inherits the same gate that lives in
  // paperclip-plugin-cad: a `scripts/validate-manifest.mjs` driver, a
  // vitest regression test, and a GitHub Actions workflow. Same code
  // shape as the cad plugin's gate so future plugin authors do not have
  // to rediscover the contract.
  writeFile(
    path.join(outputDir, "scripts", "validate-manifest.mjs"),
    `#!/usr/bin/env node
/**
 * PLA-376 — release-time plugin manifest validation gate.
 *
 * Runs the host plugin-manifest validator against the built
 * \`dist/manifest.js\` BEFORE a tarball can be packed/published. v0.1.1
 * of plugin-cad shipped with \`cad:run_script\` tool names that the
 * post-PLA-163 host validator rejects, and the release passed CI before
 * the operator's install attempt revealed the manifest was unloadable.
 * This gate makes the same class of regression a build failure.
 *
 * Resolves the manifest via package.json's \`paperclipPlugin.manifest\`
 * field (per PLUGIN_SPEC §10.1). Wired into:
 *   - \`npm run validate:manifest\` (developer ergonomic)
 *   - \`prepack\` lifecycle hook (blocks \`npm pack\` / \`npm publish\`)
 *   - \`.github/workflows/manifest-validate.yml\` (PR + push gate)
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { pluginManifestV1Schema } from "@paperclipai/shared/validators/plugin";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/**
 * PLA-163 tool-name allowlist — mirrored from the host validator's
 * \`pluginToolDeclarationSchema.name\` regex. Tool names are namespaced
 * at runtime as \`<plugin-id>:<tool-name>\`, so the bare name must not
 * contain \`:\`. A lowercase alnum allowlist also keeps whitespace,
 * control chars, path separators, and unicode lookalikes out of the
 * registry key. Mirrored here so the gate matches host behaviour even
 * when the published \`@paperclipai/shared\` lags the fork validator.
 */
const TOOL_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*$/;
const TOOL_NAME_REGEX_MESSAGE =
  "Tool name must start with a lowercase alphanumeric and contain only " +
  "lowercase letters, digits, dots, hyphens, or underscores (no ':' — see PLA-163)";

export function validateManifest(manifest) {
  const errors = [];
  const parsed = pluginManifestV1Schema.safeParse(manifest);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const p = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      errors.push(\`[zod] \${p}: \${issue.message}\`);
    }
  }
  const m = typeof manifest === "object" && manifest !== null ? manifest : {};
  if (Array.isArray(m.tools)) {
    m.tools.forEach((tool, idx) => {
      const name = tool && typeof tool === "object" ? tool.name : undefined;
      if (typeof name !== "string" || !TOOL_NAME_REGEX.test(name)) {
        errors.push(
          \`[pla-163] tools[\${idx}].name=\${JSON.stringify(name)}: \${TOOL_NAME_REGEX_MESSAGE}\`,
        );
      }
    });
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

async function loadManifestFromPackageJson() {
  const pkgPath = resolve(REPO_ROOT, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const manifestRel = pkg?.paperclipPlugin?.manifest;
  if (typeof manifestRel !== "string" || manifestRel.length === 0) {
    throw new Error(
      \`package.json is missing 'paperclipPlugin.manifest' (got \${JSON.stringify(manifestRel)}).\`,
    );
  }
  const manifestAbs = resolve(REPO_ROOT, manifestRel);
  if (!existsSync(manifestAbs)) {
    throw new Error(\`Built manifest not found at \${manifestAbs}. Run 'npm run build' first.\`);
  }
  const mod = await import(pathToFileURL(manifestAbs).href);
  return { manifest: mod?.default ?? mod, manifestAbs };
}

async function main() {
  const { manifest, manifestAbs } = await loadManifestFromPackageJson();
  const result = validateManifest(manifest);
  if (result.ok) {
    const toolCount = Array.isArray(manifest?.tools) ? manifest.tools.length : 0;
    console.log(\`[validate-manifest] OK — \${manifestAbs} (tools: \${toolCount}).\`);
    return 0;
  }
  console.error(\`[validate-manifest] FAILED — \${manifestAbs}:\`);
  for (const err of result.errors) console.error(\`  - \${err}\`);
  console.error(
    "\\nHost validator source: packages/shared/src/validators/plugin.ts (pluginManifestV1Schema).",
  );
  return 1;
}

const isDirectInvocation = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[validate-manifest] unexpected error:", err);
      process.exit(2);
    });
}
`,
  );

  writeFile(
    path.join(outputDir, "tests", "validate-manifest.spec.ts"),
    `/**
 * PLA-376 — regression coverage for the release-time manifest gate.
 * Proves the gate catches the v0.1.1 incident shape (a tool name
 * containing ':') and accepts the dot/hyphen/underscore lowercase forms
 * the host validator allows.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs has no .d.ts; the helper is plain JS by design
import { validateManifest } from "../scripts/validate-manifest.mjs";

function fixture(toolName: string) {
  return {
    id: ${quote(manifestId)},
    apiVersion: 1 as const,
    version: "0.1.0",
    displayName: ${quote(displayName)},
    description: "fixture for PLA-376 regression coverage",
    author: ${quote(author)},
    categories: [${quote(category)}] as const,
    capabilities: ["agent.tools.register"] as const,
    entrypoints: { worker: "./dist/worker.js" },
    tools: [
      {
        name: toolName,
        displayName: "Tool",
        description: "fixture tool",
        parametersSchema: { type: "object" },
      },
    ],
  };
}

describe("validate-manifest gate (PLA-376)", () => {
  it("rejects a manifest with a colon in tools[].name (the v0.1.1 incident)", () => {
    const result = validateManifest(fixture("bad:name"));
    expect(result.ok).toBe(false);
  });

  it("accepts dotted, hyphenated, and underscored lowercase names", () => {
    for (const good of ["run.script", "do-thing", "do_thing", "x"]) {
      const result = validateManifest(fixture(good));
      expect(result.ok, \`expected ok for \${JSON.stringify(good)}\`).toBe(true);
    }
  });
});
`,
  );

  writeFile(
    path.join(outputDir, ".github", "workflows", "manifest-validate.yml"),
    `name: Plugin manifest validation (release gate)

# PLA-376 — release-time check that runs the host plugin-manifest
# validator against the built dist/manifest.js BEFORE a tarball can be
# packed or published. Mirrors the gate at
# packages/plugins/create-paperclip-plugin/src/index.ts (scaffold).

on:
  pull_request:
    paths:
      - 'src/manifest.ts'
      - 'package.json'
      - 'package-lock.json'
      - 'esbuild.config.mjs'
      - 'rollup.config.mjs'
      - 'scripts/validate-manifest.mjs'
      - 'tests/validate-manifest.spec.ts'
      - '.github/workflows/manifest-validate.yml'
  push:
    branches:
      - main
    paths:
      - 'src/manifest.ts'
      - 'package.json'
      - 'package-lock.json'
      - 'esbuild.config.mjs'
      - 'rollup.config.mjs'
      - 'scripts/validate-manifest.mjs'
      - 'tests/validate-manifest.spec.ts'
      - '.github/workflows/manifest-validate.yml'

jobs:
  validate-manifest:
    name: validate dist/manifest.js against pluginManifestV1Schema
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - name: Build manifest (and worker)
        run: npm run build
      - name: Run regression test (PLA-376)
        run: npx vitest run --config ./vitest.config.ts tests/validate-manifest.spec.ts
      - name: Validate built manifest
        run: npm run validate:manifest
`,
  );

  return outputDir;
}

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

/** CLI wrapper for `scaffoldPluginProject`. */
function runCli() {
  const pluginName = process.argv[2];
  if (!pluginName) {
    // eslint-disable-next-line no-console
    console.error("Usage: create-paperclip-plugin <name> [--template default|connector|workspace] [--output <dir>] [--sdk-path <paperclip-sdk-path>]");
    process.exit(1);
  }

  const template = (parseArg("--template") ?? "default") as PluginTemplate;
  const outputRoot = parseArg("--output") ?? process.cwd();
  const targetDir = path.resolve(outputRoot, packageToDirName(pluginName));

  const out = scaffoldPluginProject({
    pluginName,
    outputDir: targetDir,
    template,
    displayName: parseArg("--display-name"),
    description: parseArg("--description"),
    author: parseArg("--author"),
    category: parseArg("--category") as ScaffoldPluginOptions["category"] | undefined,
    sdkPath: parseArg("--sdk-path"),
  });

  // eslint-disable-next-line no-console
  console.log(`Created plugin scaffold at ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
