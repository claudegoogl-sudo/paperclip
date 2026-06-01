#!/usr/bin/env node
/**
 * plugin-activation-soak.mjs
 *
 * Post-sync activation soak for first-party plugins (PLA-640). Roots in the
 * PLA-639 incident: CAD went `error` on the v525 cut with
 * `Activation failed: Package root not found for plugin "platform.cad"`.
 * The cause was not a manifest/SDK regression — CAD had been installed via
 * `plugin install -l /tmp/pla-447-extract/package`, and the host recorded that
 * `/tmp` source dir as the permanent `packagePath` *without copying* into
 * managed `node_modules` (see `plugin-loader.ts` `fetchAndValidate`, local-path
 * branch). systemd-tmpfiles swept the aged-out `/tmp` dir, so the next service
 * restart could not re-resolve the package root and activation failed.
 *
 * This soak fails the upstream-sync tick (non-zero exit) if CAD or klipper
 * cannot install + register + reach `status: "ready"` against a freshly-built
 * host, and additionally fails if any installed plugin's resolved `packagePath`
 * lands under an ephemeral / systemd-tmpfiles-swept location (`/tmp` &c.).
 *
 * One run:
 *   1. Resolve plugin specs (CAD + klipper by default; tarball paths from
 *      --plugin / env). Refuse to stage under an ephemeral path.
 *   2. Extract each tarball into a PERSISTENT staging dir
 *      (`<staging>/<name>-<version>/package`) — never `/tmp`.
 *   3. Boot an isolated host (`server/dist/index.js`) in `local_trusted` mode
 *      bound to loopback against an isolated --data-dir (NOT ~/.paperclip),
 *      with embedded PostgreSQL inside that data dir.
 *   4. For each plugin: POST /api/plugins/install (local path), poll
 *      GET /api/plugins/:key until `ready` / `error` / timeout. Assert ready
 *      and that the recorded `packagePath` is persistent.
 *   5. Uninstall the test plugins (idempotent re-runs), tear the host down,
 *      remove the isolated data dir.
 *
 * Exit code 0 iff every plugin reached `ready` with a persistent packagePath;
 * otherwise non-zero, with the captured host `lastError` and a tail of host
 * logs printed to stderr.
 *
 * Pure helpers (no I/O) are exported for unit testing — see
 * scripts/plugin-activation-soak.test.mjs.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested) — keep these free of process/network/fs side
// effects so the soak's gating logic can be verified deterministically.
// ---------------------------------------------------------------------------

/**
 * Directories that systemd-tmpfiles (or equivalent) periodically sweeps. A
 * plugin whose packagePath lives here is a PLA-639 time bomb: it activates once
 * and then breaks on the next restart after the dir ages out.
 */
export const EPHEMERAL_PATH_ROOTS = ["/tmp", "/var/tmp", "/dev/shm"];

/** Resolve the set of ephemeral roots for a run (well-known + the live tmpdir). */
export function ephemeralRoots(tmpDir = os.tmpdir()) {
  const roots = new Set(EPHEMERAL_PATH_ROOTS);
  if (tmpDir) roots.add(path.resolve(tmpDir));
  return [...roots];
}

/** True if `candidate` is at or under any ephemeral/swept root. */
export function isEphemeralPath(candidate, tmpDir = os.tmpdir()) {
  if (!candidate) return false;
  const resolved = path.resolve(candidate);
  return ephemeralRoots(tmpDir).some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(`${r}${path.sep}`);
  });
}

/**
 * Throw if `candidate` is ephemeral. `label` names the path for the error so a
 * failed soak says *which* path was the problem.
 */
export function assertPersistentPath(candidate, label, tmpDir = os.tmpdir()) {
  if (isEphemeralPath(candidate, tmpDir)) {
    throw new Error(
      `${label} resolves under an ephemeral/systemd-tmpfiles-swept path (${path.resolve(candidate)}); ` +
        `plugin packages must live in a persistent dir (e.g. ~/.paperclip/plugin-packages/<name>-<version>/package). ` +
        `See PLA-639.`,
    );
  }
  return path.resolve(candidate);
}

/** Deterministic persistent package root for a staged tarball. */
export function resolveStagedPackageRoot(stagingRoot, name, version) {
  const safeName = String(name).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const safeVersion = String(version || "0.0.0").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return path.join(path.resolve(stagingRoot), `${safeName}-${safeVersion}`, "package");
}

/**
 * Classify a poll outcome for one plugin into a pass/fail verdict.
 *
 * @param {{status?: string, packagePath?: string|null, lastError?: string|null}|null} record
 * @param {{timedOut?: boolean, tmpDir?: string}} opts
 * @returns {{ready: boolean, reason: string|null}}
 */
export function classifyPluginStatus(record, opts = {}) {
  const { timedOut = false, tmpDir = os.tmpdir() } = opts;
  if (!record) {
    return { ready: false, reason: timedOut ? "timed out before the plugin appeared in the registry" : "plugin not found in registry" };
  }
  if (record.status !== "ready") {
    if (timedOut) {
      return {
        ready: false,
        reason: `timed out in status "${record.status ?? "unknown"}"${record.lastError ? `: ${record.lastError}` : ""}`,
      };
    }
    return {
      ready: false,
      reason: `status "${record.status ?? "unknown"}"${record.lastError ? `: ${record.lastError}` : ""}`,
    };
  }
  // status === ready — still fail if the package root is on a swept path.
  if (record.packagePath && isEphemeralPath(record.packagePath, tmpDir)) {
    return {
      ready: false,
      reason: `activated but packagePath is ephemeral (${record.packagePath}); will break on the next restart — see PLA-639`,
    };
  }
  return { ready: true, reason: null };
}

/** Reduce per-plugin verdicts to an overall soak result. */
export function summarizeSoakResult(results) {
  const failures = results.filter((r) => !r.ready);
  return {
    ok: failures.length === 0,
    total: results.length,
    failures: failures.map((f) => ({ name: f.name, pluginKey: f.pluginKey, reason: f.reason })),
  };
}

/**
 * Parse a `--plugin name=tarball[:pluginKey]` spec string.
 * The pluginKey is optional; when omitted the soak resolves it from the
 * extracted manifest at install time and the assertion keys off the install
 * response instead.
 */
export function parsePluginSpec(raw) {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Error(`invalid --plugin spec "${raw}" (expected name=tarball[:pluginKey])`);
  }
  const name = raw.slice(0, eq).trim();
  let rest = raw.slice(eq + 1).trim();
  let pluginKey;
  // Split a trailing :pluginKey, but tolerate Windows-style drive colons and
  // URLs by only treating the LAST colon as a key separator when what follows
  // looks like a plugin key (contains a dot, no path separator).
  const lastColon = rest.lastIndexOf(":");
  if (lastColon > 0) {
    const tail = rest.slice(lastColon + 1);
    if (tail && !tail.includes("/") && !tail.includes(path.sep) && tail.includes(".")) {
      pluginKey = tail;
      rest = rest.slice(0, lastColon);
    }
  }
  if (!name || !rest) {
    throw new Error(`invalid --plugin spec "${raw}" (expected name=tarball[:pluginKey])`);
  }
  return { name, tarball: rest, pluginKey };
}

/**
 * Build the isolated child-host environment. PURE (no I/O) so the isolation
 * invariants are unit-testable.
 *
 * The critical hardening (PLA-650): PAPERCLIP_CONFIG is PINNED to a path under
 * the throwaway data dir — it is NOT deleted. Deleting it let the host's config
 * resolver (`resolvePaperclipConfigPath` -> `findConfigFileFromAncestors`) walk
 * cwd's ancestors UPWARD; since `~/.paperclip` is an ancestor of the repo
 * checkout, a stray/legacy `~/.paperclip/config.json` (or an operator/repo
 * `.paperclip/config.json`) would silently feed the soak a LIVE
 * `database.connectionString` + embeddedPostgresDataDir and run install/uninstall
 * **purge** against the live registry. Pointing at `<dataDir>/soak-config.json`
 * (which is never created) makes `readConfigFile()` return null deterministically
 * -> embedded PG under PAPERCLIP_HOME, with no ancestor walk. Failure-closed and
 * independent of cwd/operator layout. An inherited PAPERCLIP_CONFIG is
 * OVERRIDDEN, never honored.
 *
 * DATABASE_URL is removed so config.ts's dotenv (override:false) cannot backfill
 * the empty slot from a sibling `.paperclip/.env`, and so no inherited live URL
 * leaks in.
 *
 * @param {{dataDir: string, port: number, instanceId?: string}} opts
 * @param {NodeJS.ProcessEnv} baseEnv environment to inherit from (usually process.env)
 */
export function buildHostEnv(opts, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
    PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    HOST: "127.0.0.1",
    PORT: String(opts.port),
    PAPERCLIP_HOME: opts.dataDir,
    PAPERCLIP_INSTANCE_ID: opts.instanceId ?? `soak-${process.pid}-${Date.now()}`,
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    // Pin (do NOT delete) config into the throwaway data dir; the file is never
    // created, so the host resolves config -> null instead of walking cwd
    // ancestors up to a live ~/.paperclip/config.json. See PLA-650.
    PAPERCLIP_CONFIG: path.join(opts.dataDir, "soak-config.json"),
    NODE_ENV: baseEnv.NODE_ENV ?? "production",
  };
  // Drop any inherited live DATABASE_URL: never point at the live database, and
  // leave no empty slot for dotenv to backfill from a sibling .paperclip/.env.
  delete env.DATABASE_URL;
  return env;
}

// ---------------------------------------------------------------------------
// Config / argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    serverEntry: path.join(repoRoot, "server", "dist", "index.js"),
    dataDir: null,
    stagingDir: null,
    port: null,
    plugins: [],
    timeoutMs: 90_000,
    healthTimeoutMs: 120_000,
    keep: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--server-entry": opts.serverEntry = path.resolve(next()); break;
      case "--data-dir": opts.dataDir = path.resolve(next()); break;
      case "--staging-dir": opts.stagingDir = path.resolve(next()); break;
      case "--port": opts.port = Number(next()); break;
      case "--plugin": opts.plugins.push(parsePluginSpec(next())); break;
      case "--timeout-ms": opts.timeoutMs = Number(next()); break;
      case "--health-timeout-ms": opts.healthTimeoutMs = Number(next()); break;
      case "--keep": opts.keep = true; break;
      case "--json": opts.json = true; break;
      case "--help": case "-h": opts.help = true; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/**
 * Default plugin set: CAD + klipper. Tarball locations are not hardcoded to a
 * machine — they come from --plugin or these env vars, so the committed script
 * stays portable. The upstream-sync wiring supplies the release tarballs.
 */
function defaultPluginSpecs() {
  const specs = [];
  if (process.env.SOAK_CAD_TARBALL) {
    specs.push({ name: "cad", tarball: path.resolve(process.env.SOAK_CAD_TARBALL), pluginKey: process.env.SOAK_CAD_KEY });
  }
  if (process.env.SOAK_KLIPPER_TARBALL) {
    specs.push({ name: "klipper", tarball: path.resolve(process.env.SOAK_KLIPPER_TARBALL), pluginKey: process.env.SOAK_KLIPPER_KEY });
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Side-effecting helpers
// ---------------------------------------------------------------------------

function log(...args) {
  console.error("[soak]", ...args);
}

async function pickFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Extract a plugin tarball into a persistent `<staging>/<name>-<ver>/package`. */
function stagePluginTarball(spec, stagingRoot, tmpDir) {
  if (!existsSync(spec.tarball)) {
    throw new Error(`plugin tarball not found for "${spec.name}": ${spec.tarball}`);
  }
  // Extract to a temp dir first so we can read the manifest/version, then move
  // into the deterministic persistent path. The FINAL path is guarded; the
  // scratch extraction dir is allowed to be ephemeral.
  const scratch = mkdtempSync(path.join(os.tmpdir(), `soak-extract-${spec.name}-`));
  try {
    execFileSync("tar", ["-xzf", spec.tarball, "-C", scratch], { stdio: "pipe" });
    const extractedPackage = path.join(scratch, "package");
    const pkgJsonPath = path.join(extractedPackage, "package.json");
    if (!existsSync(pkgJsonPath)) {
      throw new Error(`tarball ${spec.tarball} does not contain package/package.json`);
    }
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    const packageName = pkgJson.name ?? spec.name;
    const version = pkgJson.version ?? "0.0.0";

    const dest = resolveStagedPackageRoot(stagingRoot, packageName, version);
    assertPersistentPath(dest, `staged package root for "${spec.name}"`, tmpDir);

    // Idempotent: clear any prior staging for this name-version.
    const destParent = path.dirname(dest);
    rmSync(destParent, { recursive: true, force: true });
    mkdirSync(destParent, { recursive: true });
    // Move scratch/package -> dest (rename is atomic on the same fs; fall back
    // to a tar repack-free recursive copy via cp for cross-device).
    try {
      execFileSync("mv", [extractedPackage, dest], { stdio: "pipe" });
    } catch {
      mkdirSync(dest, { recursive: true });
      execFileSync("cp", ["-a", `${extractedPackage}/.`, dest], { stdio: "pipe" });
    }
    return { ...spec, packageName, version, packageRoot: dest };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function bootHost(opts) {
  if (!existsSync(opts.serverEntry)) {
    throw new Error(
      `server entry not found: ${opts.serverEntry}. Build the host first (pnpm --filter @paperclipai/server build) ` +
        `or pass --server-entry.`,
    );
  }
  const env = buildHostEnv(opts, process.env);

  const child = spawn(process.execPath, [opts.serverEntry], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logTail = [];
  const capture = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      logTail.push(line);
      if (logTail.length > 200) logTail.shift();
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return { child, logTail };
}

async function waitForHealth(baseUrl, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`host process exited (code ${child.exitCode}) before becoming ready`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(`host did not report healthy at ${baseUrl}/api/health within ${timeoutMs}ms`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function installPlugin(baseUrl, packageRoot) {
  const res = await fetch(`${baseUrl}/api/plugins/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageName: packageRoot, isLocalPath: true }),
  });
  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = null; }
  if (!res.ok) {
    const detail = parsed?.error ?? parsed?.message ?? body.slice(0, 400);
    return { ok: false, error: `install HTTP ${res.status}: ${detail}`, record: parsed };
  }
  return { ok: true, record: parsed };
}

async function getPluginByKey(baseUrl, pluginKey) {
  const res = await fetch(`${baseUrl}/api/plugins/${encodeURIComponent(pluginKey)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /api/plugins/${pluginKey} -> HTTP ${res.status}`);
  return await res.json();
}

async function pollUntilSettled(baseUrl, pluginKey, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let record = null;
  while (Date.now() < deadline) {
    record = await getPluginByKey(baseUrl, pluginKey);
    if (record && (record.status === "ready" || record.status === "error")) {
      return { record, timedOut: false };
    }
    await sleep(1000);
  }
  return { record, timedOut: true };
}

async function uninstallPlugin(baseUrl, pluginKey) {
  try {
    await fetch(`${baseUrl}/api/plugins/${encodeURIComponent(pluginKey)}?purge=true`, { method: "DELETE" });
  } catch (err) {
    log(`warning: failed to uninstall ${pluginKey}: ${String(err)}`);
  }
}

async function stopHost(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((r) => child.once("exit", () => r(true))),
    sleep(10_000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function runSoak(opts) {
  const tmpDir = os.tmpdir();
  const specs = opts.plugins.length > 0 ? opts.plugins : defaultPluginSpecs();
  if (specs.length === 0) {
    throw new Error(
      "no plugins to soak. Pass --plugin name=tarball[:pluginKey] (repeatable) " +
        "or set SOAK_CAD_TARBALL / SOAK_KLIPPER_TARBALL.",
    );
  }

  // Isolated data dir — default under the repo, NEVER ~/.paperclip and NEVER
  // an ephemeral path. A throwaway dir keeps the live registry untouched.
  const dataDir = opts.dataDir ?? path.join(repoRoot, ".soak", `data-${Date.now()}`);
  assertPersistentPath(dataDir, "soak --data-dir", tmpDir);
  const stagingDir = opts.stagingDir ?? path.join(dataDir, "plugin-packages");
  assertPersistentPath(stagingDir, "soak --staging-dir", tmpDir);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });

  const port = opts.port ?? (await pickFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;

  log(`staging ${specs.length} plugin(s) into ${stagingDir}`);
  const staged = specs.map((spec) => stagePluginTarball(spec, stagingDir, tmpDir));
  for (const s of staged) log(`  ${s.name} -> ${s.packageRoot} (${s.packageName}@${s.version})`);

  let host;
  const results = [];
  const installedKeys = [];
  try {
    log(`booting isolated host on ${baseUrl} (data-dir ${dataDir})`);
    host = bootHost({ ...opts, dataDir, port });
    await waitForHealth(baseUrl, opts.healthTimeoutMs, host.child);
    log("host healthy");

    for (const spec of staged) {
      log(`installing ${spec.name} from ${spec.packageRoot}`);
      const install = await installPlugin(baseUrl, spec.packageRoot);
      let pluginKey = spec.pluginKey ?? install.record?.pluginKey ?? install.record?.manifestJson?.id;

      if (!install.ok && !pluginKey) {
        results.push({ name: spec.name, pluginKey: pluginKey ?? null, ready: false, reason: install.error, record: install.record ?? null });
        continue;
      }
      if (install.ok && !pluginKey) {
        results.push({ name: spec.name, pluginKey: null, ready: false, reason: "install succeeded but the response carried no pluginKey", record: install.record ?? null });
        continue;
      }
      if (pluginKey) installedKeys.push(pluginKey);

      if (!install.ok) {
        // Install endpoint reported failure but we know the key — read the
        // recorded error state for a precise reason.
        const record = await getPluginByKey(baseUrl, pluginKey).catch(() => null);
        const verdict = classifyPluginStatus(record ?? { status: "error", lastError: install.error }, { timedOut: false, tmpDir });
        results.push({ name: spec.name, pluginKey, ready: verdict.ready, reason: verdict.reason ?? install.error, record });
        continue;
      }

      const { record, timedOut } = await pollUntilSettled(baseUrl, pluginKey, opts.timeoutMs);
      const verdict = classifyPluginStatus(record, { timedOut, tmpDir });
      log(`  ${spec.name} (${pluginKey}): ${verdict.ready ? "READY" : `NOT READY — ${verdict.reason}`}`);
      results.push({
        name: spec.name,
        pluginKey,
        ready: verdict.ready,
        reason: verdict.reason,
        status: record?.status ?? null,
        packagePath: record?.packagePath ?? null,
        lastError: record?.lastError ?? null,
      });
    }
  } finally {
    // Idempotent cleanup: uninstall test plugins so a re-run starts clean, then
    // tear the host down and drop the throwaway data dir.
    if (host) {
      for (const key of installedKeys) await uninstallPlugin(baseUrl, key);
      await stopHost(host.child);
    }
    if (!opts.keep) {
      rmSync(dataDir, { recursive: true, force: true });
    } else {
      log(`--keep set; leaving data dir ${dataDir}`);
    }
  }

  const summary = summarizeSoakResult(results);
  const output = { ok: summary.ok, baseUrl, dataDir, plugins: results, failures: summary.failures };
  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
  }
  if (!summary.ok) {
    log("SOAK FAILED:");
    for (const f of summary.failures) log(`  - ${f.name} (${f.pluginKey ?? "?"}): ${f.reason}`);
    if (host?.logTail?.length) {
      log("--- host log tail ---");
      for (const line of host.logTail.slice(-40)) console.error(line);
    }
  } else {
    log(`SOAK PASSED: ${results.length} plugin(s) reached ready with persistent packagePath`);
  }
  return output;
}

function printHelp() {
  console.log(`plugin-activation-soak.mjs — install + activate first-party plugins against an isolated host.

Usage:
  node scripts/plugin-activation-soak.mjs [options]

Options:
  --plugin name=tarball[:pluginKey]  Plugin to soak (repeatable). pluginKey optional.
  --data-dir <path>                  Isolated data dir (default: <repo>/.soak/data-<ts>; never /tmp).
  --staging-dir <path>               Persistent tarball staging dir (default: <data-dir>/plugin-packages).
  --server-entry <path>              Built host entry (default: server/dist/index.js).
  --port <n>                         Host port (default: an ephemeral free port).
  --timeout-ms <n>                   Per-plugin readiness timeout (default 90000).
  --health-timeout-ms <n>            Host boot timeout (default 120000).
  --keep                             Do not delete the data dir on exit.
  --json                             Print the structured result to stdout.

Env defaults (used when no --plugin is given):
  SOAK_CAD_TARBALL / SOAK_CAD_KEY        CAD release tarball + optional plugin key.
  SOAK_KLIPPER_TARBALL / SOAK_KLIPPER_KEY  klipper release tarball + optional plugin key.
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }
  const result = await runSoak(opts);
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error("[soak] fatal:", err.stack || String(err));
      process.exit(1);
    });
}
