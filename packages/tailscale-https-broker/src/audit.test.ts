import { describe, expect, it } from "vitest";
import { formatAuditLine, sanitizeField, type AuditEvent } from "./audit.js";

describe("sanitizeField", () => {
  it("passes through plain ASCII text unchanged", () => {
    expect(sanitizeField("expose runtime-123")).toBe("expose runtime-123");
  });

  it("replaces C0 control characters with spaces", () => {
    expect(sanitizeField("a\x00b\x01c\x1fd")).toBe("a b c d");
  });

  it("replaces newlines and carriage returns (defeats log forging)", () => {
    expect(sanitizeField("line1\nline2\r\nFAKE: allow")).toBe("line1 line2  FAKE: allow");
  });

  it("replaces the DEL character (0x7f)", () => {
    expect(sanitizeField("a\x7fb")).toBe("a b");
  });

  it("leaves printable characters adjacent to 0x1f/0x7f boundaries untouched", () => {
    // 0x20 (space) and 0x7e (~) are the nearest printable neighbors and must
    // not be stripped.
    expect(sanitizeField("\x20~")).toBe(" ~");
  });

  it("does not touch non-ASCII Unicode text", () => {
    expect(sanitizeField("café ☃")).toBe("café ☃");
  });

  it("leaves strings at exactly the max length untouched", () => {
    const value = "a".repeat(256);
    expect(sanitizeField(value)).toBe(value);
  });

  it("truncates strings beyond the max length and appends an ellipsis", () => {
    const value = "a".repeat(300);
    const result = sanitizeField(value);
    expect(result).toBe(`${"a".repeat(256)}…`);
    expect(result.length).toBe(257);
  });

  it("applies the length bound to the sanitized string, after control chars become spaces", () => {
    // Control-character replacement is length-preserving (one char in, one
    // space out), so a string that is only over the limit because of control
    // characters is still truncated.
    const value = "a".repeat(200) + "\x00".repeat(100);
    const result = sanitizeField(value);
    expect(result).toBe(`${"a".repeat(200)}${" ".repeat(56)}…`);
    expect(result.length).toBe(257);
  });

  it("returns an empty string unchanged", () => {
    expect(sanitizeField("")).toBe("");
  });
});

describe("formatAuditLine", () => {
  function baseEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
    return {
      timestampIso: "2026-01-01T00:00:00.000Z",
      peer: { uid: 1000, gid: 1000, pid: 4242 },
      op: "expose",
      runtimeId: "runtime-abc",
      ports: [8443, 5173],
      requestId: "req-1",
      decision: "allow",
      reasonCode: "ok",
      reason: "ok",
      ...overrides,
    };
  }

  it("produces a single-line JSON object with the expected shape", () => {
    const line = formatAuditLine(baseEvent());
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      ts: "2026-01-01T00:00:00.000Z",
      uid: 1000,
      gid: 1000,
      pid: 4242,
      op: "expose",
      runtimeId: "runtime-abc",
      ports: [8443, 5173],
      requestId: "req-1",
      decision: "allow",
      reasonCode: "ok",
      reason: "ok",
      cliExitCategory: undefined,
      recovery: undefined,
    });
  });

  it("sanitizes op, runtimeId, requestId, reason, and digests", () => {
    const line = formatAuditLine(
      baseEvent({
        op: "expose\ninjected",
        runtimeId: "runtime\x00abc",
        requestId: "req\r\n1",
        reason: "denied\ndue to policy",
        beforeDigest: "digest\x01before",
        afterDigest: "digest\x01after",
      }),
    );
    const parsed = JSON.parse(line);
    expect(parsed.op).toBe("expose injected");
    expect(parsed.runtimeId).toBe("runtime abc");
    expect(parsed.requestId).toBe("req  1");
    expect(parsed.reason).toBe("denied due to policy");
    expect(parsed.beforeDigest).toBe("digest before");
    expect(parsed.afterDigest).toBe("digest after");
  });

  it("emits null for peer, runtimeId, and requestId when absent", () => {
    const line = formatAuditLine(
      baseEvent({ peer: null, runtimeId: null, requestId: null }),
    );
    const parsed = JSON.parse(line);
    expect(parsed.uid).toBeNull();
    expect(parsed.gid).toBeNull();
    expect(parsed.pid).toBeNull();
    expect(parsed.runtimeId).toBeNull();
    expect(parsed.requestId).toBeNull();
  });

  it("omits beforeDigest/afterDigest from the JSON when absent", () => {
    const line = formatAuditLine(baseEvent());
    expect(line).not.toContain("beforeDigest");
    expect(line).not.toContain("afterDigest");
  });

  it("filters out non-integer ports and bounds the list to 8 entries", () => {
    const line = formatAuditLine(
      baseEvent({
        ports: [1, 2.5, Number.NaN, 3, 4, 5, 6, 7, 8, 9, 10],
      }),
    );
    const parsed = JSON.parse(line);
    expect(parsed.ports).toEqual([1, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("passes through decision, reasonCode, cliExitCategory, and recovery verbatim", () => {
    const line = formatAuditLine(
      baseEvent({
        decision: "deny",
        reasonCode: "unauthorized_peer",
        cliExitCategory: "timeout",
        recovery: "quarantine",
      }),
    );
    const parsed = JSON.parse(line);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reasonCode).toBe("unauthorized_peer");
    expect(parsed.cliExitCategory).toBe("timeout");
    expect(parsed.recovery).toBe("quarantine");
  });

  it("never includes lease handle, bearer/session, or raw environment data by construction", () => {
    const line = formatAuditLine(baseEvent());
    const parsed = JSON.parse(line);
    const keys = Object.keys(parsed);
    expect(keys).toEqual([
      "ts",
      "uid",
      "gid",
      "pid",
      "op",
      "runtimeId",
      "ports",
      "requestId",
      "decision",
      "reasonCode",
      "reason",
    ]);
  });
});
