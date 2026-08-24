import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOW_MARKER,
  checkPublishValue,
  classifyHostIp,
  findComposeOffenses,
  findQuadletOffenses,
  parseFlowSequence,
  runCheck,
  splitTopLevelColons,
} from "./check-compose-loopback-bind.mjs";

const composeWith = (entry) => `services:\n  db:\n    image: postgres:17\n    ports:\n      - ${entry}\n`;

test("splitTopLevelColons keeps ${} and [] groups intact", () => {
  assert.deepEqual(splitTopLevelColons("${VAR:-127.0.0.1}:5432:5432"), [
    "${VAR:-127.0.0.1}",
    "5432",
    "5432",
  ]);
  assert.deepEqual(splitTopLevelColons("[::1]:3100:3100"), ["[::1]", "3100", "3100"]);
  assert.deepEqual(splitTopLevelColons("5432:5432"), ["5432", "5432"]);
});

test("rejects the pre-fix bare short-form publish", () => {
  const offenses = findComposeOffenses(composeWith('"5432:5432"'));
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 5);
  assert.match(offenses[0].reason, /without a host-IP component/);
});

test("accepts the fixed ${VAR:-127.0.0.1} publish", () => {
  const compose = composeWith('"${PAPERCLIP_DB_BIND_ADDR:-127.0.0.1}:5432:5432"');
  assert.deepEqual(findComposeOffenses(compose), []);
});

test("rejects the single-dash ${VAR-127.0.0.1} default", () => {
  const offenses = findComposeOffenses(composeWith('"${PAPERCLIP_DB_BIND_ADDR-127.0.0.1}:5432:5432"'));
  assert.equal(offenses.length, 1);
  assert.match(offenses[0].reason, /empty-but-set/);
});

test("rejects PublishPort without a host IP", () => {
  const offenses = findQuadletOffenses("[Pod]\nPodName=paperclip\nPublishPort=3100:3100\n");
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 3);
});

test("accepts PublishPort pinned to loopback", () => {
  assert.deepEqual(
    findQuadletOffenses("[Pod]\nPodName=paperclip\nPublishPort=127.0.0.1:3100:3100\n"),
    [],
  );
});

test("rejects an explicit 0.0.0.0 bind and a defaultless interpolation", () => {
  assert.equal(findComposeOffenses(composeWith('"0.0.0.0:3100:3100"')).length, 1);
  assert.equal(findComposeOffenses(composeWith('"${PAPERCLIP_BIND_ADDR}:3100:3100"')).length, 1);
});

test("accepts loopback with an interpolated host port and a protocol suffix", () => {
  assert.deepEqual(
    findComposeOffenses(composeWith('"${PAPERCLIP_BIND_ADDR:-127.0.0.1}:${PAPERCLIP_PORT:-3100}:3100"')),
    [],
  );
  assert.deepEqual(findComposeOffenses(composeWith('"127.0.0.1:5514:5514/udp"')), []);
});

test("rejects bare `::1`, which Compose does not parse as an IPv6 host", () => {
  const offenses = findComposeOffenses(composeWith('"::1:3100:3100"'));
  assert.equal(offenses.length, 1);
  assert.match(offenses[0].reason, /bracket syntax/);
  assert.deepEqual(findComposeOffenses(composeWith('"[::1]:3100:3100"')), []);
});

test("the allow marker opts out on the entry line and the line above", () => {
  assert.deepEqual(
    findComposeOffenses(composeWith(`"5432:5432" # ${ALLOW_MARKER}: lab-only stack`)),
    [],
  );
  assert.deepEqual(
    findComposeOffenses(
      `services:\n  db:\n    ports:\n      # ${ALLOW_MARKER}: lab-only stack\n      - "5432:5432"\n`,
    ),
    [],
  );
  assert.deepEqual(
    findQuadletOffenses(`[Pod]\n# ${ALLOW_MARKER}: lab-only pod\nPublishPort=3100:3100\n`),
    [],
  );
});

test("ignores keys outside a ports block and stops at the next sibling key", () => {
  const compose = [
    "services:",
    "  app:",
    "    ports:",
    '      - "127.0.0.1:3100:3100"',
    "    environment:",
    '      DATABASE_URL: "postgres://p:p@db:5432/p"',
    "    command: 5432:5432",
    "",
  ].join("\n");
  assert.deepEqual(findComposeOffenses(compose), []);
});

test("handles the flow-sequence ports form", () => {
  assert.equal(findComposeOffenses('services:\n  app:\n    ports: ["8080:8080"]\n').length, 1);
  assert.deepEqual(
    findComposeOffenses('services:\n  app:\n    ports: ["127.0.0.1:8080:8080", "[::1]:9090:9090"]\n'),
    [],
  );
});

test("handles the long ports syntax via host_ip", () => {
  const missing = [
    "services:",
    "  app:",
    "    ports:",
    "      - target: 3100",
    "        published: 3100",
    "",
  ].join("\n");
  const offenses = findComposeOffenses(missing);
  assert.equal(offenses.length, 1);
  assert.match(offenses[0].reason, /host_ip/);

  const pinned = [
    "services:",
    "  app:",
    "    ports:",
    "      - target: 3100",
    "        published: 3100",
    "        host_ip: 127.0.0.1",
    "",
  ].join("\n");
  assert.deepEqual(findComposeOffenses(pinned), []);
});

test("classifyHostIp and checkPublishValue agree on the loopback literals", () => {
  assert.ok(classifyHostIp("127.0.0.1").ok);
  assert.ok(classifyHostIp("[::1]").ok);
  assert.ok(!classifyHostIp("10.0.0.5").ok);
  assert.ok(checkPublishValue("127.0.0.1:3100:3100").ok);
  assert.ok(!checkPublishValue("3100:3100").ok);
});

test("parseFlowSequence splits on commas outside ${} groups", () => {
  assert.deepEqual(parseFlowSequence('["${A:-127.0.0.1}:1:1", "127.0.0.1:2:2"]'), [
    "${A:-127.0.0.1}:1:1",
    "127.0.0.1:2:2",
  ]);
});

test("runCheck passes on a loopback-only tree and fails on a bare publish", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "compose-loopback-"));
  try {
    mkdirSync(path.join(tmpRoot, "docker/quadlet"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "docker/docker-compose.yml"),
      composeWith('"${PAPERCLIP_DB_BIND_ADDR:-127.0.0.1}:5432:5432"'),
    );
    writeFileSync(
      path.join(tmpRoot, "docker/quadlet/paperclip.pod"),
      "[Pod]\nPodName=paperclip\nPublishPort=127.0.0.1:3100:3100\n",
    );

    const errors = [];
    assert.equal(runCheck({ repoRoot: tmpRoot, log: () => {}, error: (msg) => errors.push(msg) }), 0);
    assert.deepEqual(errors, []);

    writeFileSync(path.join(tmpRoot, "docker/docker-compose.yml"), composeWith('"5432:5432"'));
    const failures = [];
    assert.equal(
      runCheck({ repoRoot: tmpRoot, log: () => {}, error: (msg) => failures.push(msg) }),
      1,
    );
    assert.ok(failures.some((line) => line.includes("docker/docker-compose.yml:5")));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCheck ignores compose files outside docker/", () => {
  // The gate scopes its scan to `docker/`. A bare publish placed *outside*
  // that root (e.g. in `examples/`) must be ignored — but only when the
  // shipped `docker/` root itself is present and clean. Without a real
  // `docker/` directory the gate would otherwise exit 0 from a 0-file scan,
  // which is the fail-open defect covered by the next test.
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "compose-loopback-scope-"));
  try {
    mkdirSync(path.join(tmpRoot, "docker"), { recursive: true });
    mkdirSync(path.join(tmpRoot, "examples"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "docker/docker-compose.yml"),
      composeWith('"${PAPERCLIP_DB_BIND_ADDR:-127.0.0.1}:5432:5432"'),
    );
    writeFileSync(path.join(tmpRoot, "examples/docker-compose.yml"), composeWith('"5432:5432"'));
    assert.equal(runCheck({ repoRoot: tmpRoot, log: () => {}, error: () => {} }), 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCheck fails closed when the docker/ scan root is missing", () => {
  // Regression: previously, a missing `docker/` directory caused `scanned`
  // to stay at 0 and the success path returned 0 — a security control
  // silently degrading to zero coverage while reporting green.
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "compose-loopback-empty-"));
  try {
    const errors = [];
    const code = runCheck({ repoRoot: tmpRoot, log: () => {}, error: (msg) => errors.push(msg) });
    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes("scanned 0 file")), "expected fail-closed header");
    assert.ok(
      errors.some((line) => line.includes("docker")),
      "expected the missing docker/ root to be named",
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
