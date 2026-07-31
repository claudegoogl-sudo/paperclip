import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import esbuild from "esbuild";

import {
  createPluginBundlerPresets,
  DEFAULT_PLUGIN_SOURCEMAP,
  PLUGIN_SOURCEMAP_FILES_NEGATION,
  RECOMMENDED_PLUGIN_PACKAGE_FILES,
} from "../src/bundlers.js";

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

describe("createPluginBundlerPresets sourcemap default", () => {
  it("defaults every esbuild target to external sourcemaps", () => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });

    expect(DEFAULT_PLUGIN_SOURCEMAP).toBe("external");
    expect(presets.esbuild.worker.sourcemap).toBe("external");
    expect(presets.esbuild.manifest.sourcemap).toBe("external");
    expect(presets.esbuild.ui?.sourcemap).toBe("external");
  });

  it("maps the external default onto rollup's equivalent 'hidden' mode", () => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });

    expect(presets.rollup.worker.output.sourcemap).toBe("hidden");
    expect(presets.rollup.manifest.output.sourcemap).toBe("hidden");
    expect(presets.rollup.ui?.output.sourcemap).toBe("hidden");
  });

  it.each([true, false, "inline"] as const)("lets an explicit caller override win (%s)", (sourcemap) => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx", sourcemap });

    expect(presets.esbuild.worker.sourcemap).toBe(sourcemap);
    expect(presets.esbuild.manifest.sourcemap).toBe(sourcemap);
    expect(presets.esbuild.ui?.sourcemap).toBe(sourcemap);
    expect(presets.rollup.worker.output.sourcemap).toBe(sourcemap);
    expect(presets.rollup.manifest.output.sourcemap).toBe(sourcemap);
    expect(presets.rollup.ui?.output.sourcemap).toBe(sourcemap);
  });

  it("keeps the explicit external opt-in working", () => {
    const presets = createPluginBundlerPresets({ sourcemap: "external" });

    expect(presets.esbuild.worker.sourcemap).toBe("external");
    expect(presets.rollup.worker.output.sourcemap).toBe("hidden");
  });
});

describe("recommended package files", () => {
  it("carries the sourcemap negation after the dist allowlist", () => {
    expect(PLUGIN_SOURCEMAP_FILES_NEGATION).toBe("!dist/**/*.map");
    expect(RECOMMENDED_PLUGIN_PACKAGE_FILES).toContain(PLUGIN_SOURCEMAP_FILES_NEGATION);
    expect(RECOMMENDED_PLUGIN_PACKAGE_FILES.indexOf(PLUGIN_SOURCEMAP_FILES_NEGATION)).toBeGreaterThan(
      RECOMMENDED_PLUGIN_PACKAGE_FILES.indexOf("dist/"),
    );
  });
});

describe("bare-preset esbuild build", () => {
  it("writes a .map but emits no sourceMappingURL footer", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pla1840-bundlers-"));
    tempRoots.push(root);
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "worker.ts"),
      "export const SECRET_LOOKING_SOURCE_MARKER = 'plugin-source';\nexport default { marker: SECRET_LOOKING_SOURCE_MARKER };\n",
    );

    const presets = createPluginBundlerPresets({ pluginRoot: root });
    await esbuild.build({ ...presets.esbuild.worker, absWorkingDir: root });

    const bundlePath = path.join(root, "dist", "worker.js");
    const mapPath = `${bundlePath}.map`;
    const bundle = readFileSync(bundlePath, "utf8");

    expect(existsSync(mapPath)).toBe(true);
    expect(bundle).not.toContain("sourceMappingURL=");
    // The map still carries sourcesContent — that is why it must not be published.
    expect(readFileSync(mapPath, "utf8")).toContain("SECRET_LOOKING_SOURCE_MARKER");
  });
});
