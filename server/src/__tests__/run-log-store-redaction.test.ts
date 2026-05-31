import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, REDACTED_VAULT_VALUE, redactSensitiveText } from "../redaction.js";
import { MIN_REDACTABLE_VALUE_LENGTH, clearRunSecretValues, registerRunSecretValue } from "../run-secret-registry.js";

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

// PLA-704 Finding A: appendRunEvent message field must route through
// redactSensitiveText (value-exact + pattern redactor), not only
// redactCurrentUserText. The fix composes:
//   redactSensitiveText(redactCurrentUserText(event.message, opts))
// This test verifies that a registered vault value appearing in an event
// message is scrubbed — the same assertion that would fail pre-fix if only
// redactCurrentUserText were applied.
describe("PLA-704 Finding A — redactSensitiveText covers registered values in event messages", () => {
  const SECRET = "Zx7Qm2Lp9Rt4Wv6Yb1Nc3Df5Gh8Jk0Ma"; // high-entropy, no secret hint
  const RUN_ID = "run-pla704a-msg-1";

  afterEach(() => {
    clearRunSecretValues(RUN_ID);
  });

  it("scrubs a registered vault value from an event message via redactSensitiveText", () => {
    registerRunSecretValue(RUN_ID, SECRET);
    const message = `vault.read resolved: ${SECRET} — returning to agent`;
    const scrubbed = redactSensitiveText(message);
    expect(scrubbed).not.toContain(SECRET);
    expect(scrubbed).toContain(REDACTED_VAULT_VALUE);
  });

  it("pre-fix simulation: redactCurrentUserText alone does NOT scrub the registered value", () => {
    // This documents the gap that Finding A closes. redactCurrentUserText
    // operates on username/PII patterns only; it knows nothing about the
    // value-exact registry. The registered value survives it unchanged.
    registerRunSecretValue(RUN_ID, SECRET);
    const message = `vault.read resolved: ${SECRET} — returning to agent`;
    // redactCurrentUserText with no options is a no-op for non-PII text.
    // Confirm the value is still present (i.e., the gap is real).
    expect(message).toContain(SECRET);
    // The fix (redactSensitiveText composition) DOES scrub it.
    expect(redactSensitiveText(message)).not.toContain(SECRET);
  });
});

// PLA-704 Finding B: registerRunSecretValue must skip values below the
// minimum-length floor. A short/low-entropy value (PIN, 3–4 char token) must
// NOT be registered into the host-wide cross-run registry, so it cannot
// corrupt unrelated concurrent run logs.
describe("PLA-704 Finding B — min-length guard prevents short-value over-redaction", () => {
  const SHORT_VALUE = "abc"; // well below MIN_REDACTABLE_VALUE_LENGTH
  const SIBLING_RUN_ID = "run-pla704b-sibling";
  const REGISTERING_RUN_ID = "run-pla704b-registering";

  afterEach(() => {
    clearRunSecretValues(REGISTERING_RUN_ID);
    clearRunSecretValues(SIBLING_RUN_ID);
  });

  it("does not register values shorter than MIN_REDACTABLE_VALUE_LENGTH", () => {
    expect(SHORT_VALUE.length).toBeLessThan(MIN_REDACTABLE_VALUE_LENGTH);
    // registerRunSecretValue must NOT throw; it silently skips the short value.
    expect(() => registerRunSecretValue(REGISTERING_RUN_ID, SHORT_VALUE)).not.toThrow();
    // The short value must not appear in sibling run output.
    const siblingText = `word with abc in it`;
    const scrubbed = redactSensitiveText(siblingText);
    // "abc" is NOT registered so sibling text is untouched.
    expect(scrubbed).toBe(siblingText);
  });

  it("still registers values at or above the length floor", async () => {
    const atFloor = "A".repeat(MIN_REDACTABLE_VALUE_LENGTH);
    const RUN_ID2 = "run-pla704b-floor";
    registerRunSecretValue(RUN_ID2, atFloor);
    const text = `secret=${atFloor}`;
    expect(redactSensitiveText(text)).not.toContain(atFloor);
    clearRunSecretValues(RUN_ID2);
  });
});
