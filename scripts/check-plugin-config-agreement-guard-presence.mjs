#!/usr/bin/env node
/**
 * check-plugin-config-agreement-guard-presence.mjs
 *
 * The admin plugin-config write agreement guard was silently dropped once by
 * an automated catch-up merge: the guard service, its tests, its fixture,
 * its doc, and its route call site were all removed together, so there were
 * no dangling imports and no failing test — CI stayed green through the
 * whole regression. This is a wiring-presence check, not a behavioural test:
 * it asserts the guard's source symbols, call site, and test files are still
 * where the write path depends on them, so a future catch-up merge that
 * drops the same set of files fails loudly instead of silently.
 *
 * Deliberately source-level (targeted, anchored regexes over the relevant
 * files), not a DB-backed integration test — this runs in the `policy` job
 * on every PR and must stay in the single-digit seconds.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SERVICE_FILE = "server/src/services/plugin-config-write.ts";
export const ROUTE_FILE = "server/src/routes/plugins.ts";
export const AGREEMENT_FILE = "server/src/services/plugin-config-agreement.ts";
export const OPERATOR_GUIDE = "docs/guides/board-operator/plugin-config-agreement.md";

export const TEST_FILES = [
  "server/src/__tests__/plugin-config-write-agreement-guard.test.ts",
  "server/src/__tests__/plugin-config-agreement-gate.test.ts",
  "server/src/__tests__/plugin-config-route-scrub-roundtrip.test.ts",
  "server/src/__tests__/fixtures/plugin-worker-config-agreement.cjs",
];

const REVERT_WARNING =
  "A security control (the plugin-config write agreement guard) appears to have been reverted. " +
  `See ${OPERATOR_GUIDE} — if this surfaced during a merge conflict resolution, restore the ` +
  "guard rather than dropping it.";

function readIfExists(repoRoot, relativePath) {
  const absolute = path.resolve(repoRoot, relativePath);
  if (!existsSync(absolute)) return null;
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

// Strips `import { ... } from "...";` statements (including multi-line named
// import lists) so a later "is this symbol actually called" check does not
// pass on an import-only reference. Non-greedy across newlines; import
// statements never contain a `from "...";` inside their own specifier list,
// so this does not require full parsing.
function stripImportStatements(text) {
  return text.replace(/^import\s[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
}

// Strips `/* ... */` block comments and `//` line comments so a JSDoc
// mention of a symbol in prose (e.g. "via `writePluginConfigWithAgreement()`
// (`plugin-config-write.ts`)") cannot masquerade as a live call site or a
// real code reference. Deliberately naive (does not track string literals):
// good enough for the specific, narrow symbols this check looks for, and the
// files scanned here don't put those symbols inside string literals.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function exportedSymbolPattern(name) {
  return new RegExp(`^export\\s+(?:async\\s+function|function|const)\\s+${name}\\b`, "m");
}

/**
 * Runs all five presence assertions against a checkout rooted at `repoRoot`.
 * Returns a list of failures; each names the specific missing symbol/file.
 * Order-independent, position-independent (a legitimate refactor that only
 * renames a local variable or moves the route handler within its file does
 * not change any of these patterns).
 */
export function checkAssertions(repoRoot) {
  const failures = [];

  // 1. Guard service file exists and exports both entry points. Comments
  //    stripped so a doc-comment mention can't masquerade as the real export.
  const serviceText = readIfExists(repoRoot, SERVICE_FILE);
  if (serviceText === null) {
    failures.push({
      id: "service-file-missing",
      message: `Missing file: ${SERVICE_FILE}`,
    });
  } else {
    const serviceCode = stripComments(serviceText);
    for (const symbol of ["writePluginConfigWithAgreement", "evaluateConfigWriteAgreementGuard"]) {
      if (!exportedSymbolPattern(symbol).test(serviceCode)) {
        failures.push({
          id: `service-export-missing-${symbol}`,
          message: `${SERVICE_FILE} no longer exports \`${symbol}\``,
        });
      }
    }
  }

  // 2. The admin write route actually calls writePluginConfigWithAgreement
  //    (an import alone, or a doc-comment mention, does not satisfy this —
  //    see stripImportStatements/stripComments).
  const routeText = readIfExists(repoRoot, ROUTE_FILE);
  if (routeText === null) {
    failures.push({ id: "route-file-missing", message: `Missing file: ${ROUTE_FILE}` });
  } else {
    const routeCode = stripComments(routeText);
    const withoutImports = stripImportStatements(routeCode);
    if (!/\bwritePluginConfigWithAgreement\s*\(/.test(withoutImports)) {
      failures.push({
        id: "route-does-not-call-guard",
        message:
          `${ROUTE_FILE} no longer calls \`writePluginConfigWithAgreement(...)\` ` +
          "(it may still import or mention the symbol without calling it)",
      });
    }

    // 3. The route parses both fan-out flags and rejects them as mutually
    //    exclusive.
    const readsApplyToAll = /body\??\.applyToAllCompanies/.test(routeCode);
    const readsAllowDivergence = /body\??\.allowDivergence/.test(routeCode);
    if (!readsApplyToAll) {
      failures.push({
        id: "route-missing-applyToAllCompanies",
        message: `${ROUTE_FILE} no longer reads \`applyToAllCompanies\` from the request body`,
      });
    }
    if (!readsAllowDivergence) {
      failures.push({
        id: "route-missing-allowDivergence",
        message: `${ROUTE_FILE} no longer reads \`allowDivergence\` from the request body`,
      });
    }
    const rejectsMutualExclusion =
      /applyToAllCompanies\s*&&\s*allowDivergence/.test(routeCode) ||
      /allowDivergence\s*&&\s*applyToAllCompanies/.test(routeCode);
    if (!rejectsMutualExclusion) {
      failures.push({
        id: "route-missing-mutual-exclusion-check",
        message:
          `${ROUTE_FILE} no longer rejects \`applyToAllCompanies\` and \`allowDivergence\` ` +
          "as mutually exclusive",
      });
    }
  }

  // 4. Guard test suite + fixture still exist.
  for (const testFile of TEST_FILES) {
    if (!existsSync(path.resolve(repoRoot, testFile))) {
      failures.push({ id: `test-file-missing-${testFile}`, message: `Missing file: ${testFile}` });
    }
  }

  // 5. Read-side gate (getAgreedOrDeny) is still present.
  const agreementText = readIfExists(repoRoot, AGREEMENT_FILE);
  if (agreementText === null) {
    failures.push({ id: "agreement-file-missing", message: `Missing file: ${AGREEMENT_FILE}` });
  } else if (!exportedSymbolPattern("getAgreedOrDeny").test(stripComments(agreementText))) {
    failures.push({
      id: "agreement-export-missing-getAgreedOrDeny",
      message: `${AGREEMENT_FILE} no longer exports \`getAgreedOrDeny\``,
    });
  }

  return failures;
}

export function runCheck({ repoRoot, log = console.log, error = console.error } = {}) {
  const failures = checkAssertions(repoRoot);

  if (failures.length > 0) {
    error("ERROR: plugin-config write agreement guard is not fully wired up:\n");
    for (const failure of failures) {
      error(`  - ${failure.message}`);
    }
    error(`\n${REVERT_WARNING}`);
    return 1;
  }

  log("  ✓  Plugin-config write agreement guard is present and wired up.");
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const repoRoot = process.cwd();
  process.exit(runCheck({ repoRoot }));
}
