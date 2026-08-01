import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGREEMENT_FILE,
  ROUTE_FILE,
  SERVICE_FILE,
  TEST_FILES,
  checkAssertions,
  runCheck,
} from "./check-plugin-config-agreement-guard-presence.mjs";

const VALID_SERVICE = `
export function evaluateConfigWriteAgreementGuard(rows, targetCompanyId, newConfigJson, secretRefPaths) {
  return { wouldBreakAgreement: false, divergingKeys: [] };
}

export async function writePluginConfigWithAgreement(db, params) {
  return db.transaction(async (tx) => tx);
}
`;

const VALID_ROUTE = `
import {
  writePluginConfigWithAgreement,
  ConfigAgreementGuardError,
} from "../services/plugin-config-write.js";

router.post("/plugins/:pluginId/config", async (req, res) => {
  const applyToAllCompanies = body.applyToAllCompanies === true;
  const allowDivergence = body.allowDivergence === true;
  if (applyToAllCompanies && allowDivergence) {
    res.status(400).json({ error: "mutually exclusive" });
    return;
  }
  const result = await writePluginConfigWithAgreement(db, {
    pluginId: plugin.id,
    companyId,
    configJson: body.configJson,
    schema,
    options: { applyToAllCompanies, allowDivergence },
  });
  res.json(result.row);
});
`;

const VALID_AGREEMENT = `
export async function getAgreedOrDeny(deps) {
  return {};
}
`;

function writeValidFixture(root) {
  mkdirSync(path.dirname(path.resolve(root, SERVICE_FILE)), { recursive: true });
  writeFileSync(path.resolve(root, SERVICE_FILE), VALID_SERVICE);

  mkdirSync(path.dirname(path.resolve(root, ROUTE_FILE)), { recursive: true });
  writeFileSync(path.resolve(root, ROUTE_FILE), VALID_ROUTE);

  mkdirSync(path.dirname(path.resolve(root, AGREEMENT_FILE)), { recursive: true });
  writeFileSync(path.resolve(root, AGREEMENT_FILE), VALID_AGREEMENT);

  for (const testFile of TEST_FILES) {
    const absolute = path.resolve(root, testFile);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, "// test fixture placeholder\n");
  }
}

function withTempRepo(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "guard-presence-check-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("passes against a fully-wired fixture", () => {
  withTempRepo((root) => {
    writeValidFixture(root);
    assert.deepEqual(checkAssertions(root), []);
  });
});

test("fails when the guard service file is entirely missing", () => {
  withTempRepo((root) => {
    writeValidFixture(root);
    rmSync(path.resolve(root, SERVICE_FILE));
    const failures = checkAssertions(root);
    assert.ok(failures.some((f) => f.id === "service-file-missing"));
  });
});

test("fails when writePluginConfigWithAgreement export is dropped but the file remains", () => {
  withTempRepo((root) => {
    writeValidFixture(root);
    writeFileSync(
      path.resolve(root, SERVICE_FILE),
      VALID_SERVICE.replace(
        "export async function writePluginConfigWithAgreement",
        "async function writePluginConfigWithAgreement",
      ),
    );
    const failures = checkAssertions(root);
    assert.ok(failures.some((f) => f.id === "service-export-missing-writePluginConfigWithAgreement"));
  });
});

test("fails when the only mention of the guard call is inside a doc comment", () => {
  withTempRepo((root) => {
    writeValidFixture(root);
    const routeWithCommentOnlyMention = VALID_ROUTE.replace(
      /const result = await writePluginConfigWithAgreement\(db, \{[\s\S]*?\}\);/,
      "// Historically this called writePluginConfigWithAgreement() directly.\n  const result = { row: {}, fannedOut: false };",
    );
    writeFileSync(path.resolve(root, ROUTE_FILE), routeWithCommentOnlyMention);
    const failures = checkAssertions(root);
    assert.ok(failures.some((f) => f.id === "route-does-not-call-guard"));
  });
});

test("fails when the route only imports the guard but never calls it", () => {
  withTempRepo((root) => {
    writeValidFixture(root);
    const routeWithoutCall = VALID_ROUTE.replace(
      /const result = await writePluginConfigWithAgreement\(db, \{[\s\S]*?\}\);/,
      "const result = { row: {}, fannedOut: false };",
    );
    writeFileSync(path.resolve(root, ROUTE_FILE), routeWithoutCall);
    const failures = checkAssertions(root);
    assert.ok(failures.some((f) => f.id === "route-does-not-call-guard"));
  });
});

test("fails when the mutual-exclusion rejection is removed", () => {
  withTempRepo((root) => {
    writeValidFixture(root);
    const routeWithoutGuardCheck = VALID_ROUTE.replace(
      /if \(applyToAllCompanies && allowDivergence\) \{[\s\S]*?\}\n/,
      "",
    );
    writeFileSync(path.resolve(root, ROUTE_FILE), routeWithoutGuardCheck);
    const failures = checkAssertions(root);
    assert.ok(failures.some((f) => f.id === "route-missing-mutual-exclusion-check"));
  });
});

test("fails when a guard test file is deleted", () => {
  withTempRepo((root) => {
    writeValidFixture(root);
    rmSync(path.resolve(root, TEST_FILES[0]));
    const failures = checkAssertions(root);
    assert.ok(failures.some((f) => f.id === `test-file-missing-${TEST_FILES[0]}`));
  });
});

test("fails when getAgreedOrDeny is dropped from the read-side gate", () => {
  withTempRepo((root) => {
    writeValidFixture(root);
    writeFileSync(path.resolve(root, AGREEMENT_FILE), "// gate removed\n");
    const failures = checkAssertions(root);
    assert.ok(failures.some((f) => f.id === "agreement-export-missing-getAgreedOrDeny"));
  });
});

test("does not fire on a legitimate refactor: renaming an unrelated local variable", () => {
  withTempRepo((root) => {
    writeValidFixture(root);
    const renamed = VALID_ROUTE.replace(/\bresult\b/g, "writeResult");
    writeFileSync(path.resolve(root, ROUTE_FILE), renamed);
    assert.deepEqual(checkAssertions(root), []);
  });
});

test("does not fire on a legitimate refactor: moving the route handler within the file", () => {
  withTempRepo((root) => {
    writeValidFixture(root);
    const reordered = `// unrelated helper moved above\nfunction helper() { return 1; }\n${VALID_ROUTE}\n// trailing unrelated code\nfunction another() { return 2; }\n`;
    writeFileSync(path.resolve(root, ROUTE_FILE), reordered);
    assert.deepEqual(checkAssertions(root), []);
  });
});

test("runCheck returns 0 and logs success on a fully-wired fixture", () => {
  withTempRepo((root) => {
    writeValidFixture(root);
    const logs = [];
    const code = runCheck({ repoRoot: root, log: (msg) => logs.push(msg), error: () => {} });
    assert.equal(code, 0);
    assert.ok(logs.some((line) => line.includes("wired up")));
  });
});

test("runCheck returns 1 and names the missing file/symbol on a broken fixture", () => {
  withTempRepo((root) => {
    writeValidFixture(root);
    rmSync(path.resolve(root, SERVICE_FILE));
    const errors = [];
    const code = runCheck({ repoRoot: root, log: () => {}, error: (msg) => errors.push(msg) });
    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes(SERVICE_FILE)));
    assert.ok(errors.some((line) => line.includes("security control")));
  });
});
