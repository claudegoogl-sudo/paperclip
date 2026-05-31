/**
 * PLA-702 / PLA-695 Control 2 — borrowed-handle vault unit tests.
 *
 * These exercise the in-memory store directly (no DB / no worker). Each
 * assertion maps to a SecurityEngineer PLA-701 sign-off criterion (RC3/RC5)
 * or a confirmed invariant, and FAILS on pre-fix code where the module does
 * not exist.
 */

import { afterEach, describe, expect, it } from "vitest";

const {
  HANDLE_SCHEME,
  mintHandle,
  resolveHandle,
  clearRunHandles,
  substituteHandles,
  isHandleShaped,
  activeRunHandleCount,
  UnresolvedHandleError,
} = await import("../handle-vault.js");

const RUN_A = "run-aaaaaaaa";
const RUN_B = "run-bbbbbbbb";
const SECRET = "Zx7Qm2Lp9Rt4Wv6Yb1Nc3Df5Gh8Jk0Mn2Pq4Su6Xa";

afterEach(() => {
  clearRunHandles(RUN_A);
  clearRunHandles(RUN_B);
});

describe("handle minting", () => {
  it("mints an opaque 128-bit handle under the vault-handle scheme", () => {
    const handle = mintHandle(RUN_A, SECRET);
    expect(handle.startsWith(`${HANDLE_SCHEME}${RUN_A}/`)).toBe(true);
    const id = handle.slice(`${HANDLE_SCHEME}${RUN_A}/`.length);
    // 128 bits = 32 lowercase hex chars.
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // The opaque handle must NOT contain the plaintext.
    expect(handle.includes(SECRET)).toBe(false);
  });

  it("mints unique handles for repeated values", () => {
    const h1 = mintHandle(RUN_A, SECRET);
    const h2 = mintHandle(RUN_A, SECRET);
    expect(h1).not.toBe(h2);
    expect(resolveHandle(RUN_A, h1)).toBe(SECRET);
    expect(resolveHandle(RUN_A, h2)).toBe(SECRET);
  });

  it("rejects empty value / runId (fail-closed defensive guard)", () => {
    expect(() => mintHandle("", SECRET)).toThrow();
    expect(() => mintHandle(RUN_A, "")).toThrow();
  });
});

describe("RC3 — resolution is keyed by the server-validated runId", () => {
  it("a run-A handle presented during run B resolves to nothing", () => {
    const handle = mintHandle(RUN_A, SECRET);
    expect(resolveHandle(RUN_A, handle)).toBe(SECRET);
    // Same handle token, different (foreign) run → no resolution.
    expect(resolveHandle(RUN_B, handle)).toBeUndefined();
  });

  it("substitution under a foreign run fails closed", () => {
    const handle = mintHandle(RUN_A, SECRET);
    expect(() => substituteHandles(RUN_B, { token: handle })).toThrow(UnresolvedHandleError);
  });
});

describe("RC5 — substring substitution + fail-closed", () => {
  it("substitutes a handle embedded mid-string (header/url/template)", () => {
    const handle = mintHandle(RUN_A, SECRET);
    const out = substituteHandles(RUN_A, {
      headers: { Authorization: `Bearer ${handle}` },
      url: `https://api.example/?key=${handle}&x=1`,
      nested: [{ env: `TOKEN=${handle}` }],
    });
    expect(out.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(out.url).toBe(`https://api.example/?key=${SECRET}&x=1`);
    expect(out.nested[0].env).toBe(`TOKEN=${SECRET}`);
  });

  it("returns a deep copy and never mutates the input (RC4)", () => {
    const handle = mintHandle(RUN_A, SECRET);
    const input = { token: handle };
    const out = substituteHandles(RUN_A, input);
    expect(out.token).toBe(SECRET);
    // Original keeps the handle for persistence/audit.
    expect(input.token).toBe(handle);
  });

  it("passes through strings with no handle present unchanged", () => {
    const input = { a: "plain text", b: 42, c: true, d: null };
    const out = substituteHandles(RUN_A, input);
    expect(out).toEqual(input);
  });

  it("fails closed on a handle-shaped but forged token", () => {
    const forged = `${HANDLE_SCHEME}${RUN_A}/ffffffffffffffffffffffffffffffff`;
    expect(() => substituteHandles(RUN_A, { token: forged })).toThrow(UnresolvedHandleError);
  });
});

describe("lifecycle", () => {
  it("clears all borrowed handles for a run on finalize", () => {
    const handle = mintHandle(RUN_A, SECRET);
    expect(activeRunHandleCount()).toBeGreaterThanOrEqual(1);
    clearRunHandles(RUN_A);
    expect(resolveHandle(RUN_A, handle)).toBeUndefined();
  });

  it("isHandleShaped recognises the scheme", () => {
    expect(isHandleShaped(`${HANDLE_SCHEME}run/abc`)).toBe(true);
    expect(isHandleShaped("plain")).toBe(false);
  });
});
