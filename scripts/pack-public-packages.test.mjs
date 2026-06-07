import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPublishConfig,
  defaultForkBuildUrl,
  rewriteForkBuildDeps,
} from "./pack-public-packages.mjs";

test("applyPublishConfig promotes exports/main/types from publishConfig and strips publishConfig", () => {
  const input = {
    name: "@paperclipai/server",
    version: "9.9.9-test",
    type: "module",
    exports: { ".": "./src/index.ts" },
    publishConfig: {
      access: "public",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
    },
  };

  const result = applyPublishConfig(input);

  assert.deepEqual(result.exports, {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
  });
  assert.equal(result.main, "./dist/index.js");
  assert.equal(result.types, "./dist/index.d.ts");
  assert.equal(result.publishConfig, undefined);
  // input must not be mutated
  assert.deepEqual(input.exports, { ".": "./src/index.ts" });
  assert.ok(input.publishConfig, "input still carries publishConfig");
});

test("applyPublishConfig drops registry-only directives (access/registry/tag) so they don't leak onto the manifest", () => {
  const input = {
    name: "paperclipai",
    version: "1.0.0",
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
      tag: "latest",
    },
  };

  const result = applyPublishConfig(input);

  assert.equal(result.access, undefined);
  assert.equal(result.registry, undefined);
  assert.equal(result.tag, undefined);
  assert.equal(result.publishConfig, undefined);
});

test("applyPublishConfig is a no-op when publishConfig is missing", () => {
  const input = { name: "x", version: "1.0.0", main: "./index.js" };
  const result = applyPublishConfig(input);
  assert.deepEqual(result, input);
});

test("applyPublishConfig promotes bin overrides (mcp-server pattern)", () => {
  const input = {
    name: "@paperclipai/mcp-server",
    version: "1.0.0",
    bin: { "paperclip-mcp": "./src/index.ts" },
    publishConfig: {
      bin: { "paperclip-mcp": "./dist/index.js" },
      exports: { ".": { import: "./dist/index.js" } },
    },
  };
  const result = applyPublishConfig(input);
  assert.deepEqual(result.bin, { "paperclip-mcp": "./dist/index.js" });
});

// ── PLA-498 rewriteForkBuildDeps ────────────────────────────────────────────
//
// These tests guard the fork-build URL-rewrite step that used to live as
// undocumented manual work after fork-build-1..6. Forgetting it broke
// fork-build-7 install with `ETARGET` because internal @paperclipai/*
// packages do not exist on the public npm registry; the only resolvable
// source is the GitHub-Release tarball URL embedded by this rewriter.

const FORK_BUILD_VERSION = "2026.428.1-fork.9";
const FORK_BUILD_TAG = "fork-build-9";
const RELEASES_BASE = `https://github.com/claudegoogl-sudo/paperclip/releases/download/${FORK_BUILD_TAG}`;

function expectedUrl(shortName) {
  return `${RELEASES_BASE}/paperclipai-${shortName}-${FORK_BUILD_VERSION}.tgz`;
}

test("rewriteForkBuildDeps rewrites bare-semver @paperclipai/* deps to fork-build URLs", () => {
  const input = {
    name: "@paperclipai/server",
    version: FORK_BUILD_VERSION,
    dependencies: {
      "@paperclipai/db": FORK_BUILD_VERSION,
      "@paperclipai/shared": FORK_BUILD_VERSION,
    },
  };

  const result = rewriteForkBuildDeps(input, {
    workspaceVersions: new Map([
      ["@paperclipai/db", FORK_BUILD_VERSION],
      ["@paperclipai/shared", FORK_BUILD_VERSION],
    ]),
    releaseTag: FORK_BUILD_TAG,
  });

  assert.deepEqual(result.dependencies, {
    "@paperclipai/db": expectedUrl("db"),
    "@paperclipai/shared": expectedUrl("shared"),
  });
  // input is not mutated
  assert.equal(input.dependencies["@paperclipai/db"], FORK_BUILD_VERSION);
});

test("rewriteForkBuildDeps resolves workspace:* via workspaceVersions map", () => {
  const input = {
    name: "@paperclipai/server",
    version: FORK_BUILD_VERSION,
    dependencies: {
      "@paperclipai/db": "workspace:*",
      "@paperclipai/shared": "workspace:^",
    },
  };

  const result = rewriteForkBuildDeps(input, {
    workspaceVersions: new Map([
      ["@paperclipai/db", FORK_BUILD_VERSION],
      ["@paperclipai/shared", FORK_BUILD_VERSION],
    ]),
    releaseTag: FORK_BUILD_TAG,
  });

  assert.equal(result.dependencies["@paperclipai/db"], expectedUrl("db"));
  assert.equal(result.dependencies["@paperclipai/shared"], expectedUrl("shared"));
});

test("rewriteForkBuildDeps is idempotent — already-rewritten deps stay unchanged", () => {
  const alreadyRewritten = {
    name: "@paperclipai/server",
    version: FORK_BUILD_VERSION,
    dependencies: {
      "@paperclipai/db": expectedUrl("db"),
      "@paperclipai/shared": expectedUrl("shared"),
    },
  };

  const result = rewriteForkBuildDeps(alreadyRewritten, {
    workspaceVersions: new Map(),
    releaseTag: FORK_BUILD_TAG,
  });

  assert.deepEqual(result.dependencies, alreadyRewritten.dependencies);

  // Running it twice in a row must produce the same shape — the regression
  // we're guarding against is the manual step being half-applied across
  // tarballs. The pipeline must be safe to re-run.
  const again = rewriteForkBuildDeps(result, {
    workspaceVersions: new Map(),
    releaseTag: FORK_BUILD_TAG,
  });
  assert.deepEqual(again.dependencies, alreadyRewritten.dependencies);
});

test("rewriteForkBuildDeps leaves non-@paperclipai deps untouched", () => {
  const input = {
    name: "@paperclipai/server",
    version: FORK_BUILD_VERSION,
    dependencies: {
      "@paperclipai/db": FORK_BUILD_VERSION,
      zod: "^3.22.0",
      react: "18.2.0",
      "@types/node": "^20.0.0",
    },
    devDependencies: {
      typescript: "^5.0.0",
    },
  };

  const result = rewriteForkBuildDeps(input, {
    workspaceVersions: new Map([["@paperclipai/db", FORK_BUILD_VERSION]]),
    releaseTag: FORK_BUILD_TAG,
  });

  assert.equal(result.dependencies["@paperclipai/db"], expectedUrl("db"));
  assert.equal(result.dependencies["zod"], "^3.22.0");
  assert.equal(result.dependencies["react"], "18.2.0");
  assert.equal(result.dependencies["@types/node"], "^20.0.0");
  assert.deepEqual(result.devDependencies, { typescript: "^5.0.0" });
});

test("rewriteForkBuildDeps walks the full CLI dep set (fb6 shape: all 12 internal packages)", () => {
  // The CLI tarball used to ship all 12 @paperclipai/* deps in fork-build-6;
  // fork-build-7 regressed it to just @paperclipai/server. This test pins the
  // rewriter's behaviour against the fb6 shape so a future caller passing
  // the full set gets every entry rewritten and nothing silently dropped.
  const CLI_INTERNAL_DEPS = [
    "@paperclipai/adapter-acpx-local",
    "@paperclipai/adapter-claude-local",
    "@paperclipai/adapter-codex-local",
    "@paperclipai/adapter-cursor-local",
    "@paperclipai/adapter-gemini-local",
    "@paperclipai/adapter-openclaw-gateway",
    "@paperclipai/adapter-opencode-local",
    "@paperclipai/adapter-pi-local",
    "@paperclipai/adapter-utils",
    "@paperclipai/db",
    "@paperclipai/server",
    "@paperclipai/shared",
  ];

  const dependencies = Object.fromEntries(CLI_INTERNAL_DEPS.map((n) => [n, FORK_BUILD_VERSION]));
  dependencies["zod"] = "^3.22.0"; // sanity that non-internal deps survive in the same shape

  const result = rewriteForkBuildDeps(
    { name: "paperclipai", version: FORK_BUILD_VERSION, dependencies },
    {
      workspaceVersions: new Map(CLI_INTERNAL_DEPS.map((n) => [n, FORK_BUILD_VERSION])),
      releaseTag: FORK_BUILD_TAG,
    },
  );

  for (const name of CLI_INTERNAL_DEPS) {
    const short = name.slice("@paperclipai/".length);
    assert.equal(
      result.dependencies[name],
      expectedUrl(short),
      `${name} should be rewritten to its fork-build URL`,
    );
  }
  assert.equal(result.dependencies["zod"], "^3.22.0");
  assert.equal(Object.keys(result.dependencies).length, CLI_INTERNAL_DEPS.length + 1);
});

test("rewriteForkBuildDeps fails loudly when releaseTag is missing and deps need rewriting", () => {
  const input = {
    name: "@paperclipai/server",
    version: FORK_BUILD_VERSION,
    dependencies: { "@paperclipai/db": FORK_BUILD_VERSION },
  };

  assert.throws(
    () =>
      rewriteForkBuildDeps(input, {
        workspaceVersions: new Map([["@paperclipai/db", FORK_BUILD_VERSION]]),
        // releaseTag intentionally omitted
      }),
    /releaseTag is required/,
  );

  assert.throws(
    () =>
      rewriteForkBuildDeps(input, {
        workspaceVersions: new Map([["@paperclipai/db", FORK_BUILD_VERSION]]),
        releaseTag: "",
      }),
    /releaseTag is required/,
  );
});

test("rewriteForkBuildDeps is a silent no-op when there are no @paperclipai/* deps", () => {
  // No internal deps → no rewriting needed → no tag required. This is the
  // canary/stable publish path: bare semver deps on the real npm registry.
  const input = {
    name: "paperclipai",
    version: FORK_BUILD_VERSION,
    dependencies: { zod: "^3.22.0", react: "18.2.0" },
  };
  const result = rewriteForkBuildDeps(input, { workspaceVersions: new Map() });
  assert.deepEqual(result.dependencies, input.dependencies);
});

test("defaultForkBuildUrl matches the GitHub-Release filename convention", () => {
  assert.equal(
    defaultForkBuildUrl({
      name: "@paperclipai/server",
      version: FORK_BUILD_VERSION,
      releaseTag: FORK_BUILD_TAG,
    }),
    expectedUrl("server"),
  );
});
