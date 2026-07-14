/**
 * PLA-190 / PLA-193 — the plugin `secrets.resolve` host handler must never echo
 * a rejected secret-ref value into its error message, and the worker-manager
 * host-error boundary must scrub any secret-shaped text as defense in depth.
 *
 * Two layers under test:
 *
 *  1. Source (plugin-secrets-handler): a rejected ref is answered with a static
 *     typed-code error whose message is a fixed generic string. Even if the
 *     rejected input is itself secret-shaped (an operator pasting a PAT into a
 *     `format: "secret-ref"` slot), the value must not appear in the message,
 *     which flows to server.log and back to the worker over JSON-RPC.
 *  2. Boundary (plugin-worker-manager): every host-handler error passes through
 *     `redactSensitiveText` before it is logged or returned, so a future handler
 *     that interpolates worker input cannot leak it. We assert the redactor
 *     scrubs the same probe shapes the boundary relies on.
 *
 * Constraint (PLA-193): no real leaked value is used — only synthetic,
 * shape-valid strings built at runtime.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: vi.fn().mockResolvedValue("unused"),
  }),
}));

const { createPluginSecretsHandler, SecretsError } = await import(
  "../services/plugin-secrets-handler.js"
);
const { redactSensitiveText } = await import("../redaction.js");

// Synthetic, shape-valid probes — never a real credential (PLA-193 constraint).
const GHP_PROBE = "ghp_" + "A".repeat(36); // classic PAT shape, 40 chars
const FINE_GRAINED_PROBE = "github_pat_11" + "B".repeat(80); // fine-grained PAT
// Synthetic 3-segment JWT: every segment is >= 8 base64url chars so it matches
// the shared JWT redaction regex. Payload/signature are placeholder bytes.
const JWT_PROBE =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXBsYWNlaG9sZGVyIn0.c2lnbmF0dXJlX3BsYWNlaG9sZGVyX3h5eg";
const BEARER_JWT_PROBE = `Bearer ${JWT_PROBE}`;

function makeHandler() {
  return createPluginSecretsHandler({
    db: {} as never,
    pluginDbId: "00000000-0000-0000-0000-000000000001",
    pluginKey: "platform.test",
  });
}

async function resolveError(secretRef: unknown): Promise<Error> {
  return makeHandler()
    .resolve({ secretRef: secretRef as never, runId: "run-x" })
    .then(
      () => {
        throw new Error("resolve() unexpectedly succeeded");
      },
      (err: unknown) => err as Error,
    );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secrets.resolve source error redaction (PLA-190/PLA-193)", () => {
  it("does not echo a raw GitHub PAT (ghp_*) input into the error message", async () => {
    const err = await resolveError(GHP_PROBE);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as InstanceType<typeof SecretsError>).code).toBe("invalid_ref");
    expect(err.message).toBe("invalid secret reference");
    expect(err.message).not.toContain(GHP_PROBE);
    expect(err.message).not.toContain("ghp_");
  });

  it("does not echo a fine-grained PAT (github_pat_*) input into the error message", async () => {
    const err = await resolveError(FINE_GRAINED_PROBE);
    expect(err.message).not.toContain(FINE_GRAINED_PROBE);
    expect(err.message).not.toContain("github_pat_");
  });

  it("does not echo an Authorization Bearer value into the error message", async () => {
    const err = await resolveError(BEARER_JWT_PROBE);
    expect(err.message).not.toContain(JWT_PROBE);
    expect(err.message).not.toContain(BEARER_JWT_PROBE);
  });

  it("rejects empty/null/non-string inputs without crashing or leaking", async () => {
    for (const bad of [null, undefined, "", "   ", 12345, {}, []]) {
      const err = await resolveError(bad);
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as InstanceType<typeof SecretsError>).code).toBe("invalid_ref");
      expect(err.message).toBe("invalid secret reference");
    }
  });
});

describe("worker-manager host-error boundary redaction (PLA-190/PLA-193 AC2-B)", () => {
  // The boundary wraps errorMessage through redactSensitiveText before both
  // log.error and the JSON-RPC error response. These assert the redactor scrubs
  // the shapes it documents coverage for, so a future leaky handler cannot
  // egress that secret material even though the secrets handler itself already
  // echoes nothing at source.
  it("scrubs classic GitHub PAT (ghp_*) and Bearer JWT shapes", () => {
    const ghpLine = `host handler failed: rejected input ${GHP_PROBE} at gate`;
    expect(redactSensitiveText(ghpLine)).not.toContain(GHP_PROBE);

    const bearerLine = `host handler failed: ${BEARER_JWT_PROBE}`;
    expect(redactSensitiveText(bearerLine)).not.toContain(JWT_PROBE);
  });

  // PLA-1637: the boundary redactor now scrubs the fine-grained `github_pat_`
  // shape too. `redactSensitiveText` gates on a `github_pat_` hint and reuses the
  // canonical secret-patterns matcher, closing the gap this test formerly pinned
  // open. The secrets.resolve source path was already safe (echoes no input);
  // this remains defense-in-depth for any future leaky host handler.
  it("scrubs the fine-grained github_pat_ shape at the boundary (PLA-1637)", () => {
    const line = `host handler failed: rejected input ${FINE_GRAINED_PROBE} at gate`;
    expect(redactSensitiveText(line)).not.toContain(FINE_GRAINED_PROBE);
  });

  // A lone fine-grained PAT with no other secret-ish hint must not short-circuit
  // the SECRET_TEXT_HINTS gate unredacted (the exact class the pin above tracked).
  it("scrubs a lone github_pat_ that carries no other secret hint (PLA-1637)", () => {
    expect(redactSensitiveText(FINE_GRAINED_PROBE)).not.toContain(FINE_GRAINED_PROBE);
  });
});
