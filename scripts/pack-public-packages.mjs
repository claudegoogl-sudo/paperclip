#!/usr/bin/env node
/**
 * pack-public-packages.mjs — PLA-298, PLA-498
 *
 * Pack every public workspace package into a destination directory with the
 * package's `publishConfig` block deep-merged into the top-level manifest
 * BEFORE pack runs, then strip `publishConfig` from the packed manifest.
 *
 * Why: `npm pack` does not apply `publishConfig` (only `npm publish` does).
 * The fork-build flow uses `npm pack` to produce GitHub-Release tarballs
 * (see PLA-289 plan, PLA-298 issue), so without a pre-pack rewrite the
 * shipped tarballs declare `exports → ./src/index.ts` and the host crashes
 * on `import "@paperclipai/server"` at runtime. fork-build-1 hit exactly
 * this trap; fork-build-2 was unblocked by manually post-rewriting each
 * tarball — fragile and unreproducible. This script commits that fix.
 *
 * PLA-498 adds the second half of the fork-build pre-pack rewrite: each
 * inner `package.json`'s `@paperclipai/*` workspace deps are rewritten from
 * `workspace:*` (or bare semver) to a GitHub-Release tarball URL keyed on
 * the active fork-build tag. Before PLA-498 this was an undocumented
 * manual post-pack step done for fork-build-1..6 and forgotten for
 * fork-build-7, which then failed install with `ETARGET` because none of
 * the internal `@paperclipai/*` packages exist on the public npm registry.
 *
 * Discovery + topological order are reused from `release-package-map.mjs`
 * (the existing release flow already trusts that ordering).
 *
 * The CLI package (`paperclipai`) is intentionally skipped here — the
 * existing `scripts/build-npm.sh` + `scripts/generate-npm-package-json.mjs`
 * pipeline already produces a publishable CLI manifest with bundled deps,
 * and applying publishConfig a second time would be redundant. The CLI
 * manifest gets the same fork-build URL-rewrite by calling
 * `rewriteForkBuildDeps` directly from `generate-npm-package-json.mjs`
 * (gated on `FORK_BUILD_TAG`), so the rewrite logic stays in one place.
 *
 * Usage:
 *   FORK_BUILD_TAG=fork-build-9 node scripts/pack-public-packages.mjs --out <dir>
 *   node scripts/pack-public-packages.mjs --out <dir> --release-tag fork-build-9
 *   node scripts/pack-public-packages.mjs --out <dir> --packer pnpm
 *   node scripts/pack-public-packages.mjs --out <dir> --include @paperclipai/server
 *   node scripts/pack-public-packages.mjs --out <dir> --skip paperclipai
 *
 * The release tag (`FORK_BUILD_TAG` env or `--release-tag`) is REQUIRED.
 * This script is fork-build only; missing input fails loudly rather than
 * silently producing tarballs with unresolvable bare-semver internal deps.
 *
 * Idempotent: every package.json mutation is wrapped in a try/finally that
 * restores the original file even if pack fails or the process is killed.
 * Re-running the dep rewriter against an already-rewritten manifest is a
 * no-op (fully-qualified URL values are left untouched).
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const ROOTS = ["packages", "server", "ui", "cli"];

// CLI is built + packed by build-npm.sh, which already produces a
// fully-replaced publishable package.json (see generate-npm-package-json.mjs).
// Re-applying publishConfig here would clobber that work.
const DEFAULT_SKIP = new Set(["paperclipai"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function discoverPublicPackages() {
  const packages = [];

  function walk(relDir) {
    const absDir = join(repoRoot, relDir);
    if (!existsSync(absDir)) return;

    const pkgPath = join(absDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (!pkg.private) {
        packages.push({
          dir: relDir,
          absDir,
          pkgPath,
          name: pkg.name,
          version: pkg.version,
          pkg,
        });
      }
      return;
    }

    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      walk(join(relDir, entry.name));
    }
  }

  for (const rel of ROOTS) walk(rel);
  return packages;
}

function sortTopologically(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];

  function visit(pkg) {
    if (visited.has(pkg.name)) return;
    if (visiting.has(pkg.name)) {
      throw new Error(`cycle detected in public package graph at ${pkg.name}`);
    }
    visiting.add(pkg.name);
    const sections = [
      pkg.pkg.dependencies ?? {},
      pkg.pkg.optionalDependencies ?? {},
      pkg.pkg.peerDependencies ?? {},
    ];
    for (const deps of sections) {
      for (const depName of Object.keys(deps)) {
        const dep = byName.get(depName);
        if (dep) visit(dep);
      }
    }
    visiting.delete(pkg.name);
    visited.add(pkg.name);
    ordered.push(pkg);
  }

  for (const pkg of [...packages].sort((a, b) => a.dir.localeCompare(b.dir))) {
    visit(pkg);
  }
  return ordered;
}

/**
 * Apply publishConfig to a package.json the same way `npm publish` would:
 * deep-merge each key from publishConfig into the top-level manifest, then
 * remove the publishConfig block from the published view.
 *
 * Mirrors the npm 10.x behaviour documented at
 * https://docs.npmjs.com/cli/v10/configuring-npm/package-json#publishconfig
 * and the pnpm equivalent.
 */
export function applyPublishConfig(pkg) {
  const publishConfig = pkg.publishConfig;
  if (!publishConfig || typeof publishConfig !== "object") return pkg;

  const next = { ...pkg };
  for (const [key, value] of Object.entries(publishConfig)) {
    // `access` is an npm-registry directive, not a manifest field; do not
    // promote it onto the published package.json (npm strips it).
    if (key === "access") continue;
    // `registry` and `tag` are publish-time directives that don't belong on
    // the manifest itself; skip them as well.
    if (key === "registry" || key === "tag") continue;
    next[key] = value;
  }
  delete next.publishConfig;
  return next;
}

/**
 * Internal scope prefix for the packages this pipeline owns. Anything that
 * doesn't start with this is left alone by the rewriter (e.g. `react`,
 * `zod`, `@types/*`).
 */
const PAPERCLIPAI_SCOPE = "@paperclipai/";

const FORK_BUILD_DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

/**
 * Default URL builder for fork-build tarballs. Mirrors the manual rewrite
 * fork-build-1..6 carried out by hand: the inner `package.json` of each
 * tarball points internal `@paperclipai/*` deps at a GitHub-Release asset
 * on the `claudegoogl-sudo/paperclip` fork. The asset name follows
 * npm/pnpm's `pack` convention of `<scope>-<name>-<version>.tgz`, where
 * the scope's `@` is dropped and `/` becomes `-`. So `@paperclipai/server`
 * @ 2026.428.1-fork.6 → `paperclipai-server-2026.428.1-fork.6.tgz`.
 */
export function defaultForkBuildUrl({ name, version, releaseTag }) {
  if (!name.startsWith(PAPERCLIPAI_SCOPE)) {
    throw new Error(`defaultForkBuildUrl: ${name} is not an ${PAPERCLIPAI_SCOPE}* package`);
  }
  const short = name.slice(PAPERCLIPAI_SCOPE.length);
  return `https://github.com/claudegoogl-sudo/paperclip/releases/download/${releaseTag}/paperclipai-${short}-${version}.tgz`;
}

/**
 * Return true if a dep specifier is already a fully-qualified tarball URL.
 * Used to keep `rewriteForkBuildDeps` idempotent — running the rewriter a
 * second time against an already-rewritten manifest must be a no-op so the
 * pipeline can be re-run safely.
 */
function isTarballUrl(value) {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

/**
 * Return true if a dep specifier is a pnpm `workspace:` protocol reference.
 * These are what live on disk in the pre-pack staging manifests (e.g.
 * `workspace:*`, `workspace:^`, `workspace:~`, `workspace:1.2.3`). pnpm's
 * own pack step would rewrite them to bare semver — we replace them with a
 * release URL instead so the published tarball resolves on `npm install`.
 */
function isWorkspaceProtocol(value) {
  return typeof value === "string" && value.startsWith("workspace:");
}

/**
 * Resolve the concrete version for a workspace dep entry.
 *
 * - `workspace:*` / `workspace:^` / `workspace:~` / `workspace:` →
 *   look up the workspace package's own version from `workspaceVersions`.
 *   The `workspace:<semver>` form (e.g. `workspace:1.2.3`) uses the inline
 *   semver instead — this is how `release-package-map.mjs` pins versions
 *   for stable publishes.
 * - bare semver (e.g. `2026.428.1-fork.7`) → use the value verbatim. We
 *   don't try to validate it against `workspaceVersions` because by the
 *   time the rewriter runs in the pipeline, `release-package-map.mjs` may
 *   have already pinned the manifest to the active build version.
 *
 * Anything else (URL, file:, link:, npm:, git:) is rejected here — the
 * caller filters URLs out first via `isTarballUrl`, and other protocols
 * have no sane fork-build mapping.
 */
function resolveDepVersion({ name, value, workspaceVersions }) {
  if (isWorkspaceProtocol(value)) {
    const suffix = value.slice("workspace:".length);
    // workspace:1.2.3 — explicit version after the protocol.
    if (suffix && !["*", "^", "~", ""].includes(suffix)) {
      return suffix;
    }
    const wsVersion = workspaceVersions.get(name);
    if (!wsVersion) {
      throw new Error(
        `rewriteForkBuildDeps: workspace version unknown for ${name} (value=${value}). ` +
          `Pass it in workspaceVersions or pre-pin the manifest before calling the rewriter.`,
      );
    }
    return wsVersion;
  }
  if (typeof value === "string" && value.length > 0) {
    // Bare semver / range. Use as-is; the pack pipeline pins this upstream.
    return value;
  }
  throw new Error(`rewriteForkBuildDeps: unsupported dep specifier for ${name}: ${JSON.stringify(value)}`);
}

/**
 * Rewrite every `@paperclipai/*` dep in a publishable package.json so its
 * version specifier points at a GitHub-Release tarball URL on the fork,
 * instead of the bare semver that pnpm pack would otherwise emit. The
 * tarballs are the only thing that exists for these versions — none of the
 * internal `@paperclipai/*` packages are published to the public npm
 * registry — so without this rewrite `npm install` on the CLI tarball
 * fails with `ETARGET` (fork-build-7 regression).
 *
 * Contract:
 * - Pure: does not mutate `pkg`. Returns a new object with the same shape.
 * - Idempotent: an already-rewritten manifest is returned unchanged.
 * - Loud: throws if `releaseTag` is missing/empty when there is anything
 *   to rewrite. Silent skips were the fork-build-7 failure mode.
 * - Scoped: only walks `dependencies`, `devDependencies`,
 *   `optionalDependencies`. `peerDependencies` are caller-supplied and
 *   left alone.
 */
export function rewriteForkBuildDeps(pkg, options = {}) {
  const {
    workspaceVersions = new Map(),
    releaseTag,
    urlTemplate = defaultForkBuildUrl,
    scope = PAPERCLIPAI_SCOPE,
  } = options;

  // Decide upfront whether anything needs rewriting so the "missing tag"
  // failure mode is loud regardless of dep ordering.
  let candidateCount = 0;
  for (const section of FORK_BUILD_DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, value] of Object.entries(deps)) {
      if (!name.startsWith(scope)) continue;
      if (isTarballUrl(value)) continue;
      candidateCount += 1;
    }
  }

  if (candidateCount === 0) {
    // Nothing to do — return a shallow clone so callers can rely on a new
    // object reference whether or not rewriting happened.
    return { ...pkg };
  }

  if (!releaseTag || typeof releaseTag !== "string") {
    throw new Error(
      "rewriteForkBuildDeps: releaseTag is required when " +
        `${scope}* deps are present. ` +
        "Set FORK_BUILD_TAG (e.g. FORK_BUILD_TAG=fork-build-9) or pass --release-tag <tag>. " +
        "This used to be a manual post-pack step (fork-build-1..6); fork-build-7 broke install " +
        "because it was skipped silently. See PLA-490 / PLA-498.",
    );
  }

  const next = { ...pkg };
  for (const section of FORK_BUILD_DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;
    const rewritten = {};
    let changed = false;
    for (const [name, value] of Object.entries(deps)) {
      if (!name.startsWith(scope)) {
        rewritten[name] = value;
        continue;
      }
      if (isTarballUrl(value)) {
        rewritten[name] = value;
        continue;
      }
      const version = resolveDepVersion({ name, value, workspaceVersions });
      rewritten[name] = urlTemplate({ name, version, releaseTag });
      changed = true;
    }
    next[section] = changed ? rewritten : { ...deps };
  }
  return next;
}

/**
 * Pull the configured fork-build release tag from the environment. Used by
 * both the pack pipeline here and by `generate-npm-package-json.mjs` so
 * the env-var contract stays in one place.
 */
export function readForkBuildTagFromEnv(env = process.env) {
  const raw = env.FORK_BUILD_TAG;
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseArgs(argv) {
  const args = {
    outDir: null,
    packer: "pnpm", // pnpm pack respects publishConfig too; we apply it ourselves so either packer is correct now
    include: new Set(),
    skip: new Set(DEFAULT_SKIP),
    releaseTag: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      args.outDir = argv[i + 1];
      i += 1;
    } else if (arg === "--packer") {
      args.packer = argv[i + 1];
      i += 1;
    } else if (arg === "--include") {
      args.include.add(argv[i + 1]);
      i += 1;
    } else if (arg === "--skip") {
      args.skip.add(argv[i + 1]);
      i += 1;
    } else if (arg === "--release-tag") {
      args.releaseTag = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  process.stdout.write(
    [
      "Usage: node scripts/pack-public-packages.mjs --out <dir> [options]",
      "",
      "Options:",
      "  --out <dir>          destination directory for tarballs (required)",
      "  --release-tag <tag>  fork-build release tag (e.g. fork-build-9);",
      "                       overrides FORK_BUILD_TAG env. Required (env or flag).",
      "  --packer <bin>       'pnpm' (default) or 'npm'",
      "  --include <name>     restrict to specific package(s); repeatable",
      "  --skip <name>        skip specific package(s); repeatable. Defaults: paperclipai",
      "",
    ].join("\n"),
  );
}

function packOne(pkg, outDir, packer, { releaseTag, workspaceVersions }) {
  const backupPath = `${pkg.pkgPath}.pack-backup`;
  copyFileSync(pkg.pkgPath, backupPath);

  let cleanupNeeded = true;
  const restore = () => {
    if (!cleanupNeeded) return;
    cleanupNeeded = false;
    try {
      renameSync(backupPath, pkg.pkgPath);
    } catch {
      // If restore fails, leave the backup so a human can recover.
    }
  };

  // Surface failures (SIGINT etc.) to restore promptly.
  const onExit = () => restore();
  process.on("exit", onExit);
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });

  try {
    const published = applyPublishConfig(pkg.pkg);
    const rewritten = rewriteForkBuildDeps(published, { workspaceVersions, releaseTag });
    writeJson(pkg.pkgPath, rewritten);

    const packArgs = ["pack", "--pack-destination", resolve(outDir)];
    const result = spawnSync(packer, packArgs, {
      cwd: pkg.absDir,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`${packer} pack failed for ${pkg.name} (exit ${result.status})`);
    }
  } finally {
    restore();
    process.removeListener("exit", onExit);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.outDir) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  // CLI flag wins over env so a one-off override doesn't require unset/set.
  const releaseTag = args.releaseTag ?? readForkBuildTagFromEnv();
  if (!releaseTag) {
    process.stderr.write(
      "pack-public-packages: release tag is required.\n" +
        "  Set FORK_BUILD_TAG (e.g. FORK_BUILD_TAG=fork-build-9) or pass --release-tag <tag>.\n" +
        "  Internal @paperclipai/* deps need to be rewritten to GitHub-Release tarball URLs.\n" +
        "  See PLA-490 / PLA-498 for the regression this guards against.\n",
    );
    process.exit(1);
  }

  const outDir = resolve(args.outDir);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const allPackages = discoverPublicPackages();
  // Build a name→version map so the rewriter can resolve workspace:* refs
  // without re-reading each package.json from disk.
  const workspaceVersions = new Map(allPackages.map((p) => [p.name, p.version]));

  const ordered = sortTopologically(allPackages);
  const targets = ordered.filter((pkg) => {
    if (args.skip.has(pkg.name)) return false;
    if (args.include.size > 0 && !args.include.has(pkg.name)) return false;
    return true;
  });

  if (targets.length === 0) {
    process.stderr.write("no packages matched after include/skip filters\n");
    process.exit(1);
  }

  process.stdout.write(
    `==> Packing ${targets.length} public package(s) into ${outDir} (release tag: ${releaseTag})\n`,
  );
  for (const pkg of targets) {
    process.stdout.write(`  - ${pkg.name}@${pkg.version}\n`);
    packOne(pkg, outDir, args.packer, { releaseTag, workspaceVersions });
  }
  process.stdout.write(`==> Done. Tarballs in ${outDir}\n`);
}

// Allow `import { applyPublishConfig } from ...` for tests without running main().
const isDirect =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`pack-public-packages: ${err.message}\n`);
    process.exit(1);
  }
}
