#!/usr/bin/env node
/**
 * Fork-release preflight gate.
 *
 * Proves a release set is installable and bootable BEFORE it is published:
 *
 *   1. checksums   every tarball matches SHA256SUMS (when provided)
 *   2. closure     every internal dep in every tarball is the exact
 *                  `releases/download/v<version>/<asset>.tgz` URL, and every
 *                  referenced asset exists in the set (bare-version pins fail)
 *   3. exports     every manifest on the core install closure points its
 *                  main/exports/types targets at files that ship in the same
 *                  tarball (a dev manifest like `exports -> ./src/index.ts`
 *                  without `src/` fails here, and would also fail at boot)
 *   4. install     clean-sandbox `npm install --prefix <sandbox> <core-url>`
 *                  resolving the full internal graph from the exact release
 *                  URLs — no `file:` and no local overrides
 *   5. boot        run the installed core against a scratch data dir
 *                  (embedded Postgres on an ephemeral port, isolated HOME)
 *   6. serve       `GET /` must answer HTTP 200 with `<title>Paperclip</title>`
 *
 * Any failure exits non-zero and names the failing step plus the offending
 * package/URL (step 5 includes the tail of the boot log).
 *
 * Teardown always runs: the booted process group is killed and the scratch
 * Postgres data dir lock holder is terminated; the script verifies the
 * ports are released before exiting.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  coreChainClosure,
  listTarballs,
  readPackedManifest,
  scanExportTargets,
  scanUrlClosure,
  verifyChecksums,
} from "./lib.mjs";

const DEFAULT_HTTP_PORT = 3199;
const DEFAULT_PG_PORT = 35432;
const BOOT_TIMEOUT_MS_DEFAULT = 180_000;

function parseArgs(argv) {
  const args = {
    coreUrl: null,
    assetsDir: null,
    sumsPath: null,
    workdir: null,
    httpPort: DEFAULT_HTTP_PORT,
    pgPort: DEFAULT_PG_PORT,
    bootTimeoutMs: BOOT_TIMEOUT_MS_DEFAULT,
    steps: ["checksums", "closure", "exports", "install", "boot"],
    keep: false,
    summaryPath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--core-url") args.coreUrl = next();
    else if (arg === "--assets-dir") args.assetsDir = next();
    else if (arg === "--sha256sums") args.sumsPath = next();
    else if (arg === "--workdir") args.workdir = next();
    else if (arg === "--http-port") args.httpPort = Number(next());
    else if (arg === "--pg-port") args.pgPort = Number(next());
    else if (arg === "--boot-timeout-ms") args.bootTimeoutMs = Number(next());
    else if (arg === "--steps") args.steps = next().split(",");
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--summary") args.summaryPath = next();
    else if (arg === "--help") args.help = true;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!args.help) {
    if (!args.coreUrl) throw new Error("--core-url is required (the exact release URL of the core CLI tarball)");
    if (!args.assetsDir) throw new Error("--assets-dir is required (directory holding every release tarball)");
  }
  return args;
}

const logLines = [];
function log(message) {
  const line = `[preflight ${new Date().toISOString()}] ${message}`;
  process.stdout.write(`${line}\n`);
  logLines.push(line);
}

const summary = { ok: false, steps: {}, failures: [] };

function fail(step, message, detail) {
  summary.steps[step] = "FAIL";
  summary.failures.push({ step, message, detail: detail ?? null });
  log(`FAIL [${step}] ${message}`);
  if (detail) {
    for (const line of String(detail).split("\n").slice(0, 40)) log(`  | ${line}`);
  }
  throw new GateError(step, message, detail);
}

class GateError extends Error {
  constructor(step, message, detail) {
    super(`${step}: ${message}`);
    this.step = step;
    this.detail = detail;
  }
}

function pass(step, message) {
  summary.steps[step] = "PASS";
  log(`PASS [${step}] ${message}`);
}

function skip(step, reason) {
  summary.steps[step] = `SKIPPED (${reason})`;
  log(`SKIP [${step}] ${reason}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const coreAsset = path.basename(new URL(args.coreUrl).pathname);
  const version = coreAsset.match(/^paperclipai-(.+)\.tgz$/)?.[1];
  if (!version) throw new Error(`cannot parse version from core URL: ${args.coreUrl}`);
  summary.coreUrl = args.coreUrl;
  summary.version = version;

  const sandbox = args.workdir ?? mkdtempSync(path.join(tmpdir(), "fork-release-preflight-"));
  summary.sandbox = sandbox;
  log(`sandbox: ${sandbox}`);

  let exitCode = 0;
  let booted = null;
  try {
    const wants = (step) => args.steps.includes(step);

    if (wants("checksums")) {
      if (args.sumsPath && existsSync(args.sumsPath)) {
        const result = verifyChecksums({ assetsDir: args.assetsDir, sumsPath: args.sumsPath });
        if (!result.ok) fail("checksums", "tarball sha256 mismatch vs SHA256SUMS", JSON.stringify(result.violations, null, 2));
        pass("checksums", `all ${listTarballs(args.assetsDir).length} tarballs match SHA256SUMS`);
      } else {
        skip("checksums", "no SHA256SUMS provided");
      }
    } else skip("checksums", "not selected");

    if (wants("closure")) {
      const closure = scanUrlClosure({ assetsDir: args.assetsDir, version });
      summary.referenceCount = closure.references.length;
      if (!closure.ok) {
        fail("closure", "internal dependency graph is not fully pinned to this release's URLs", JSON.stringify(closure.violations, null, 2));
      }
      pass("closure", `${closure.references.length} internal dep pins across ${listTarballs(args.assetsDir).length} tarballs resolve inside this release`);
    } else skip("closure", "not selected");

    if (wants("exports")) {
      const chain = coreChainClosure({ assetsDir: args.assetsDir, coreTarballName: coreAsset });
      const violations = [];
      for (const [assetName, { tarballPath }] of chain) {
        const scan = scanExportTargets(tarballPath);
        violations.push(...scan.violations.map((v) => ({ asset: assetName, ...v })));
      }
      summary.coreChainAssets = [...chain.keys()];
      if (violations.length > 0) {
        fail("exports", "packed manifests on the install closure point at files that do not ship", JSON.stringify(violations, null, 2));
      }
      pass("exports", `install closure (${chain.size} packages) ships every declared export target`);
    } else skip("exports", "not selected");

    if (wants("install")) {
      const prefix = path.join(sandbox, "prefix");
      mkdirSync(prefix, { recursive: true });
      const env = installEnv(sandbox);
      log(`installing ${args.coreUrl} -> ${prefix}`);
      const result = spawnSync("npm", [
        "install", "--prefix", prefix,
        "--no-audit", "--no-fund",
        "--loglevel", "warn",
        "--fetch-retries", "2",
        args.coreUrl,
      ], { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60_000 });
      if (result.status !== 0) {
        fail("install", `npm install of the core release URL failed (exit ${result.status})`, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
      }
      const installedManifest = JSON.parse(readFileSync(path.join(prefix, "node_modules", "paperclipai", "package.json"), "utf8"));
      if (installedManifest.version !== version) {
        fail("install", `installed core version ${installedManifest.version} != release version ${version}`);
      }
      summary.installedPackages = countInstalled(prefix);
      pass("install", `${summary.installedPackages} packages installed from the release URL graph; core ${installedManifest.version}`);
    } else skip("install", "not selected");

    if (wants("boot")) {
      const prefix = path.join(sandbox, "prefix");
      if (!existsSync(path.join(prefix, "node_modules", "paperclipai"))) {
        fail("boot", "boot step requested but install did not run in this invocation (use --steps install,boot)");
      }
      booted = await bootAndProbe({ args, sandbox, version });
      summary.httpPort = args.httpPort;
      summary.health = booted.health ?? null;
      pass("boot", `server up on 127.0.0.1:${args.httpPort}; GET / 200 with expected <title>`);
    } else skip("boot", "not selected");

    summary.ok = true;
  } catch (error) {
    exitCode = 1;
    if (!(error instanceof GateError)) {
      summary.failures.push({ step: "unexpected", message: error.message, stack: error.stack });
      log(`FAIL [unexpected] ${error.message}`);
    }
  } finally {
    if (booted) teardown(booted, args);
    writeSummary(args, summary, logLines);
    if (!args.keep && summary.failures.length === 0) {
      rmSync(sandbox, { recursive: true, force: true });
      log(`sandbox removed (${sandbox}); use --keep to retain it`);
    }
  }
  log(summary.ok ? "RESULT: PASS" : `RESULT: FAIL (${summary.failures.map((f) => f.step).join(", ")})`);
  process.exit(exitCode);
}

function usage() {
  return [
    "Usage: node scripts/fork-release/preflight.mjs --core-url <release-url> --assets-dir <dir> [options]",
    "",
    "Options:",
    "  --core-url <url>        exact release URL of the core CLI tarball (required)",
    "  --assets-dir <dir>      directory holding every tarball in the release (required)",
    "  --sha256sums <file>     SHA256SUMS file to verify tarballs against",
    "  --workdir <dir>         use a specific sandbox directory (default: fresh temp dir)",
    "  --http-port <port>      port the scratch server binds (default 3199)",
    "  --pg-port <port>        port for the scratch embedded Postgres (default 35432)",
    "  --boot-timeout-ms <ms>  how long to wait for GET / (default 180000)",
    "  --steps <list>          subset: checksums,closure,exports,install,boot",
    "  --summary <file>        write a JSON summary of the run",
    "  --keep                  keep the sandbox dir after the run",
  ].join("\n");
}

function installEnv(sandbox) {
  const env = { ...process.env };
  env.HOME = sandbox;
  env.npm_config_cache = path.join(sandbox, "npm-cache");
  env.npm_config_update_notifier = "false";
  delete env.npm_config_registry; // default registry, no overrides
  return env;
}

function countInstalled(prefix) {
  const nm = path.join(prefix, "node_modules");
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSafe(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statIsDir(full)) {
        if (entry.startsWith("@")) walk(full);
        else count += 1;
      }
    }
  };
  walk(nm);
  return count;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function statIsDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function bootAndProbe({ args, sandbox, version }) {
  const prefix = path.join(sandbox, "prefix");
  const pkgJsonPath = path.join(prefix, "node_modules", "paperclipai", "package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.paperclipai;
  if (!binRel) fail("boot", "installed core package declares no bin entry");
  const entry = path.join(prefix, "node_modules", "paperclipai", binRel);

  const home = path.join(sandbox, "home");
  mkdirSync(home, { recursive: true });
  const configPath = path.join(sandbox, "config.json");
  writeFileSync(configPath, JSON.stringify({
    $meta: { version: 1, updatedAt: new Date().toISOString(), source: "doctor" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(sandbox, "db"),
      embeddedPostgresPort: args.pgPort,
      backup: { enabled: false },
    },
    logging: { mode: "file", logDir: path.join(sandbox, "logs") },
    server: {
      deploymentMode: "authenticated",
      exposure: "private",
      host: "127.0.0.1",
      port: args.httpPort,
      serveUi: true,
    },
    telemetry: { enabled: false },
  }, null, 2));

  const env = {
    HOME: home,
    PATH: process.env.PATH,
    PORT: String(args.httpPort),
    PAPERCLIP_CONFIG: configPath,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    PAPERCLIP_AGENT_JWT_SECRET: randomBytes(32).toString("hex"),
    NODE_ENV: "production",
  };

  const bootLogPath = path.join(sandbox, "boot.log");
  const bootLog = openBootLog(bootLogPath);
  log(`booting installed core ${version} (entry ${path.basename(entry)}) on 127.0.0.1:${args.httpPort}, pg :${args.pgPort}`);
  const child = spawn(process.execPath, [entry, "run"], {
    cwd: home,
    env,
    detached: true, // own process group so teardown can kill server + postmaster together
    stdio: ["ignore", bootLog, bootLog],
  });
  const booted = { child, bootLogPath, bootLog, args, sandbox };

  const deadline = Date.now() + args.bootTimeoutMs;
  let lastStatus = 0;
  let bodySample = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail("boot", `installed server exited during startup (code ${child.exitCode}, signal ${child.signalCode})`, bootLogTail(bootLogPath));
    }
    const probe = await probeRoot(args.httpPort);
    lastStatus = probe.status;
    bodySample = probe.body.slice(0, 400);
    if (probe.status === 200 && probe.body.includes("<title>Paperclip</title>")) {
      booted.health = await probeHealth(args.httpPort);
      return booted;
    }
    await sleep(1000);
  }
  fail("boot", `GET / never returned 200 with <title>Paperclip</title> within ${args.bootTimeoutMs}ms (last status ${lastStatus}${bodySample ? `, body: ${bodySample}` : ""})`, bootLogTail(bootLogPath));
  return booted;
}

function openBootLog(p) {
  return openSync(p, "a");
}
function bootLogTail(p) {
  try {
    const content = readFileSync(p, "utf8");
    return content.length > 8000 ? `...\n${content.slice(-8000)}` : content;
  } catch {
    return "(boot log unavailable)";
  }
}

function probeRoot(port) {
  return probe(port, "/").then((res) => ({
    status: res.status,
    body: res.body,
  }));
}

function probe(port, requestPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: requestPath, timeout: 4000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "" });
    });
  });
}

async function probeHealth(port) {
  const res = await probe(port, "/api/health");
  try {
    return { status: res.status, body: JSON.parse(res.body) };
  } catch {
    return { status: res.status, body: res.body.slice(0, 200) };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function teardown(booted, args) {
  const { child, args: bootArgs, sandbox } = booted;
  log("teardown: stopping server + scratch Postgres");
  try {
    if (child.pid && child.exitCode === null) {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {}
  // Postmaster fallback: the data dir lock names the PID; kill it if it survives the group kill.
  const postmasterPid = readPostmasterPid(path.join(sandbox, "db"));
  waitForExit(child, 5000).then(async () => {
    if (postmasterPid && pidAlive(postmasterPid)) {
      killTree(postmasterPid);
    }
    const httpFree = await portFree(bootArgs.httpPort);
    const pgFree = await portFree(bootArgs.pgPort);
    log(`teardown: http port ${bootArgs.httpPort} ${httpFree ? "released" : "STILL BOUND"}; pg port ${bootArgs.pgPort} ${pgFree ? "released" : "STILL BOUND"}`);
    summary.teardown = { httpPortReleased: !!httpFree, pgPortReleased: !!pgFree };
  });
}

function readPostmasterPid(dataDir) {
  try {
    return Number(readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n")[0]);
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      if (pidAlive(pid)) process.kill(pid, "SIGKILL");
    } catch {}
  }, 2000);
}

function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
      resolve();
    }, ms);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 700 }, () => resolve(false));
    req.on("error", () => resolve(true));
    req.on("timeout", () => {
      req.destroy();
      resolve(true);
    });
  });
}

function writeSummary(args, summaryData, logs) {
  if (!args.summaryPath) return;
  try {
    writeFileSync(args.summaryPath, JSON.stringify({ ...summaryData, log: logs }, null, 2));
  } catch (error) {
    log(`could not write summary: ${error.message}`);
  }
}

main().catch((error) => {
  process.stderr.write(`preflight: ${error.message}\n`);
  process.exit(1);
});
