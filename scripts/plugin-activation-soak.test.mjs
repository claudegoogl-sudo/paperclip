import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPersistentPath,
  buildHostEnv,
  classifyPluginStatus,
  isEphemeralPath,
  parsePluginSpec,
  resolveStagedPackageRoot,
  summarizeSoakResult,
} from "./plugin-activation-soak.mjs";

const TMP = "/tmp";

test("isEphemeralPath flags /tmp, /var/tmp, /dev/shm and the live tmpdir", () => {
  assert.equal(isEphemeralPath("/tmp/pla-447-extract/package", TMP), true);
  assert.equal(isEphemeralPath("/var/tmp/x", TMP), true);
  assert.equal(isEphemeralPath("/dev/shm/y", TMP), true);
  assert.equal(isEphemeralPath(path.join(os.tmpdir(), "z"), os.tmpdir()), true);
  // exact root also counts
  assert.equal(isEphemeralPath("/tmp", TMP), true);
});

test("isEphemeralPath allows persistent paths", () => {
  assert.equal(isEphemeralPath("/home/paperclip/.paperclip/plugin-packages/cad-0.1.6/package", TMP), false);
  assert.equal(isEphemeralPath("/opt/paperclip/plugins/x", TMP), false);
  // a path that merely starts with the same prefix string but is a sibling dir
  assert.equal(isEphemeralPath("/tmpfoo/bar", TMP), false);
  assert.equal(isEphemeralPath(null, TMP), false);
});

test("assertPersistentPath throws on ephemeral, returns resolved path otherwise", () => {
  assert.throws(
    () => assertPersistentPath("/tmp/cad/package", "staged package root", TMP),
    /ephemeral.*PLA-639/s,
  );
  assert.equal(
    assertPersistentPath("/home/paperclip/.paperclip/plugin-packages/cad/package", "x", TMP),
    "/home/paperclip/.paperclip/plugin-packages/cad/package",
  );
});

test("classifyPluginStatus: ready + persistent path passes", () => {
  const verdict = classifyPluginStatus(
    { status: "ready", packagePath: "/home/p/.paperclip/plugin-packages/cad-0.1.6/package", lastError: null },
    { tmpDir: TMP },
  );
  assert.deepEqual(verdict, { ready: true, reason: null });
});

test("classifyPluginStatus: this is the PLA-639 trap — ready but /tmp packagePath FAILS", () => {
  const verdict = classifyPluginStatus(
    { status: "ready", packagePath: "/tmp/pla-447-extract/package", lastError: null },
    { tmpDir: TMP },
  );
  assert.equal(verdict.ready, false);
  assert.match(verdict.reason, /ephemeral.*PLA-639/s);
});

test("classifyPluginStatus: error status surfaces lastError", () => {
  const verdict = classifyPluginStatus(
    { status: "error", packagePath: null, lastError: 'Package root not found for plugin "platform.cad"' },
    { tmpDir: TMP },
  );
  assert.equal(verdict.ready, false);
  assert.match(verdict.reason, /Package root not found for plugin "platform.cad"/);
});

test("classifyPluginStatus: timeout in non-ready status fails with status + error", () => {
  const verdict = classifyPluginStatus(
    { status: "installed", packagePath: null, lastError: null },
    { timedOut: true, tmpDir: TMP },
  );
  assert.equal(verdict.ready, false);
  assert.match(verdict.reason, /timed out in status "installed"/);
});

test("classifyPluginStatus: missing record fails", () => {
  assert.equal(classifyPluginStatus(null, { tmpDir: TMP }).ready, false);
  assert.equal(classifyPluginStatus(null, { timedOut: true, tmpDir: TMP }).ready, false);
});

test("summarizeSoakResult: ok only when every plugin ready", () => {
  const allReady = summarizeSoakResult([
    { name: "cad", pluginKey: "platform.cad", ready: true, reason: null },
    { name: "klipper", pluginKey: "platform.klipper", ready: true, reason: null },
  ]);
  assert.equal(allReady.ok, true);
  assert.equal(allReady.failures.length, 0);

  const oneBad = summarizeSoakResult([
    { name: "cad", pluginKey: "platform.cad", ready: false, reason: "boom" },
    { name: "klipper", pluginKey: "platform.klipper", ready: true, reason: null },
  ]);
  assert.equal(oneBad.ok, false);
  assert.deepEqual(oneBad.failures, [{ name: "cad", pluginKey: "platform.cad", reason: "boom" }]);
});

test("resolveStagedPackageRoot is deterministic, persistent, and sanitizes scoped names", () => {
  const root = resolveStagedPackageRoot("/home/p/.paperclip/plugin-packages", "@platform/paperclip-klipper", "0.1.6");
  assert.equal(root, "/home/p/.paperclip/plugin-packages/platform-paperclip-klipper-0.1.6/package");
  assert.equal(isEphemeralPath(root, TMP), false);
});

test("buildHostEnv pins PAPERCLIP_CONFIG into the data dir — the PLA-650 isolation invariant", () => {
  const dataDir = "/home/p/.paperclip-soak/data-123";
  // A hostile/legacy inherited env: a live config + a live DATABASE_URL that
  // MUST NOT reach the booted soak host.
  const baseEnv = {
    PAPERCLIP_CONFIG: "/x/.paperclip/config.json",
    DATABASE_URL: "postgres://live-host/prod",
    NODE_ENV: "test",
    SOME_UNRELATED: "keepme",
  };
  const env = buildHostEnv({ dataDir, port: 4321, instanceId: "soak-fixed" }, baseEnv);

  // PAPERCLIP_CONFIG is pinned under the data dir (NOT deleted) and OVERRIDES
  // the inherited live path so no cwd-ancestor walk can reach ~/.paperclip.
  assert.equal(env.PAPERCLIP_CONFIG, path.join(dataDir, "soak-config.json"));
  assert.ok(
    env.PAPERCLIP_CONFIG.startsWith(dataDir + path.sep),
    "PAPERCLIP_CONFIG must live under the throwaway data dir",
  );
  assert.notEqual(env.PAPERCLIP_CONFIG, "/x/.paperclip/config.json");
  assert.ok("PAPERCLIP_CONFIG" in env, "PAPERCLIP_CONFIG must be set, never deleted");

  // Inherited live DATABASE_URL is dropped entirely (no empty-slot dotenv backfill).
  assert.equal("DATABASE_URL" in env, false);

  // Isolation knobs are pinned regardless of the inherited env.
  assert.equal(env.PAPERCLIP_DEPLOYMENT_MODE, "local_trusted");
  assert.equal(env.PAPERCLIP_DEPLOYMENT_EXPOSURE, "private");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.PAPERCLIP_HOME, dataDir);
  assert.equal(env.PORT, "4321");

  // Unrelated inherited vars are preserved.
  assert.equal(env.SOME_UNRELATED, "keepme");
});

test("buildHostEnv pins PAPERCLIP_CONFIG even when the base env has none set", () => {
  const dataDir = "/srv/soak/data-9";
  const env = buildHostEnv({ dataDir, port: 9, instanceId: "x" }, { NODE_ENV: "production" });
  assert.equal(env.PAPERCLIP_CONFIG, path.join(dataDir, "soak-config.json"));
  assert.equal("DATABASE_URL" in env, false);
});

test("parsePluginSpec parses name=tarball[:pluginKey]", () => {
  assert.deepEqual(parsePluginSpec("cad=/abs/path/cad-0.1.6.tgz"), {
    name: "cad",
    tarball: "/abs/path/cad-0.1.6.tgz",
    pluginKey: undefined,
  });
  assert.deepEqual(parsePluginSpec("cad=/abs/path/cad-0.1.6.tgz:platform.cad"), {
    name: "cad",
    tarball: "/abs/path/cad-0.1.6.tgz",
    pluginKey: "platform.cad",
  });
  assert.throws(() => parsePluginSpec("noequals"), /invalid --plugin spec/);
});
