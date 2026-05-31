import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, REDACTED_VAULT_VALUE, redactSensitiveText } from "../redaction.js";
import { clearRunSecretValues, registerRunSecretValue } from "../run-secret-registry.js";

let tmpDir: string;
let getRunLogStore: typeof import("../services/run-log-store.js").getRunLogStore;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-redaction-"));
  process.env.RUN_LOG_BASE_PATH = tmpDir;
  // Import after env var is set so the singleton picks up our tmp basePath.
  ({ getRunLogStore } = await import("../services/run-log-store.js"));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("RunLogStore.append() secret redaction", () => {
  it("redacts ghp_ tokens from chunks before writing to NDJSON on disk", async () => {
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-redaction",
      agentId: "agent-redaction",
      runId: "run-ghp-1",
    });

    const token = `ghp_${"A".repeat(36)}`;
    const ts = "2026-05-01T12:00:00.000Z";
    await store.append(handle, {
      stream: "stdout",
      ts,
      chunk: `leaked token: ${token} after`,
    });

    const absPath = path.resolve(tmpDir, handle.logRef);
    const persisted = await fs.readFile(absPath, "utf8");

    // File on disk must not contain the plaintext token.
    expect(persisted).not.toContain(token);

    // NDJSON line should preserve schema shape (ts, stream, chunk) and contain the redaction marker.
    const lines = persisted.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toEqual({
      ts,
      stream: "stdout",
      chunk: `leaked token: ${REDACTED_EVENT_VALUE} after`,
    });
  });

  it("preserves non-secret chunk content unchanged", async () => {
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-redaction",
      agentId: "agent-redaction",
      runId: "run-ghp-2",
    });

    const ts = "2026-05-01T12:00:01.000Z";
    const chunk = "ordinary plugin output: hello world\n";
    await store.append(handle, { stream: "stderr", ts, chunk });

    const absPath = path.resolve(tmpDir, handle.logRef);
    const persisted = await fs.readFile(absPath, "utf8");
    const parsed = JSON.parse(persisted.trim());
    expect(parsed).toEqual({ ts, stream: "stderr", chunk });
  });
});

describe("RunLogStore.append() value-exact vault redaction (PLA-697)", () => {
  // High-entropy value with NO secret-ish field name, no dots, and no secret
  // text hint — so it can ONLY be caught by value-exact matching, not by the
  // pattern/heuristic redactor.
  const VAULT_VALUE = "Zx7Qm2Lp9Rt4Wv6Yb1Nc3Df5Gh8Jk0Mn2Pq4Su6Xa";
  const RUN_ID = "run-vault-exact-1";

  afterEach(() => {
    clearRunSecretValues(RUN_ID);
  });

  it("redacts a registered high-entropy vault value from persisted chunks", async () => {
    registerRunSecretValue(RUN_ID, VAULT_VALUE);
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-redaction",
      agentId: "agent-redaction",
      runId: RUN_ID,
    });

    const ts = "2026-05-01T12:00:02.000Z";
    await store.append(handle, {
      stream: "stdout",
      ts,
      // The plaintext appears in free-form content, exactly as platform.vault's
      // vault.read echoes it on the tool result `content` field.
      chunk: `the secret is ${VAULT_VALUE} done`,
    });

    const absPath = path.resolve(tmpDir, handle.logRef);
    const persisted = await fs.readFile(absPath, "utf8");

    expect(persisted).not.toContain(VAULT_VALUE);
    const parsed = JSON.parse(persisted.trim());
    expect(parsed).toEqual({
      ts,
      stream: "stdout",
      chunk: `the secret is ${REDACTED_VAULT_VALUE} done`,
    });
  });

  it("stops redacting once the run's values are cleared (rotation / no cross-run leak)", async () => {
    // No registration this time (afterEach cleared the prior run).
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-redaction",
      agentId: "agent-redaction",
      runId: "run-vault-exact-2",
    });

    const ts = "2026-05-01T12:00:03.000Z";
    const chunk = `the secret is ${VAULT_VALUE} done`;
    await store.append(handle, { stream: "stdout", ts, chunk });

    const absPath = path.resolve(tmpDir, handle.logRef);
    const persisted = await fs.readFile(absPath, "utf8");
    const parsed = JSON.parse(persisted.trim());
    // After clearing, the value is no longer registered, so the heuristic
    // redactor leaves this hint-free value untouched.
    expect(parsed).toEqual({ ts, stream: "stdout", chunk });
  });
});

// ── Finding A regression (PLA-704) ───────────────────────────────────────────
// event.message must be routed through redactSensitiveText so value-exact and
// pattern redactors both see it (not just redactCurrentUserText).
describe("redactSensitiveText covers event.message field (Finding A, PLA-704)", () => {
  const HIGH_ENTROPY = "Zx7Qm2Lp9Rt4Wv6Yb1Nc3Df5Gh8Jk0MnABC";
  const RUN_ID = "run-704-finding-a";

  afterEach(() => {
    clearRunSecretValues(RUN_ID);
  });

  it("redacts a registered vault value that appears in a message string", () => {
    registerRunSecretValue(RUN_ID, HIGH_ENTROPY);
    const message = `tool returned: ${HIGH_ENTROPY} end`;
    const result = redactSensitiveText(message);
    expect(result).not.toContain(HIGH_ENTROPY);
    expect(result).toContain(REDACTED_VAULT_VALUE);
  });
});

// ── Finding B regression (PLA-704) ───────────────────────────────────────────
// Short (< 8 char) values must be silently skipped by registerRunSecretValue so
// they can never cause over-redaction in sibling runs' logs.
describe("registerRunSecretValue short-value guard (Finding B, PLA-704)", () => {
  const SHORT_VALUE = "abc";
  const RUN_A = "run-704-finding-b-a";
  const RUN_B = "run-704-finding-b-b";

  afterEach(() => {
    clearRunSecretValues(RUN_A);
    clearRunSecretValues(RUN_B);
  });

  it("does not register a value shorter than the minimum length floor", () => {
    // Must not throw, and the short value must not be redacted from any string.
    expect(() => registerRunSecretValue(RUN_A, SHORT_VALUE)).not.toThrow();
    const input = `status: ${SHORT_VALUE} ok`;
    const result = redactSensitiveText(input);
    expect(result).toBe(input);
  });

  it("short value registered by run A does not corrupt run B log content", async () => {
    registerRunSecretValue(RUN_A, SHORT_VALUE);
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-redaction",
      agentId: "agent-redaction",
      runId: RUN_B,
    });

    const ts = "2026-05-31T00:00:00.000Z";
    // RUN_B's log contains the same short token but should NOT be redacted.
    const chunk = `sibling log contains the value ${SHORT_VALUE} inline`;
    await store.append(handle, { stream: "stdout", ts, chunk });

    const absPath = path.resolve(tmpDir, handle.logRef);
    const persisted = await fs.readFile(absPath, "utf8");
    const parsed = JSON.parse(persisted.trim());
    expect(parsed).toEqual({ ts, stream: "stdout", chunk });
  });
});
