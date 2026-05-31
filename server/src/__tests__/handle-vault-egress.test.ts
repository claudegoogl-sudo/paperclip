/**
 * PLA-723 — handle-vault egress capture + EG3 revocation purge.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  collectHandleTokens,
  clearRunHandles,
  getHandleRecord,
  mintHandle,
  purgeHandlesByBinding,
  resolveHandle,
} from "../handle-vault.js";

const RUN_A = "run-egress-vault-a";
const RUN_B = "run-egress-vault-b";
const SECRET = "Zx7Qm2Lp9Rt4Wv6Yb1Nc3Df5Gh8Jk0Mn2Pq4Su6Xa";

afterEach(() => {
  clearRunHandles(RUN_A);
  clearRunHandles(RUN_B);
});

describe("mint-time egress capture", () => {
  it("captures allowlist + enforced + bindingId immutably on the record", () => {
    const handle = mintHandle(RUN_A, SECRET, {
      allowedEgress: ["https://api.github.com"],
      enforced: true,
      bindingId: "bind-1",
    });
    const rec = getHandleRecord(RUN_A, handle);
    expect(rec).toMatchObject({
      value: SECRET,
      allowedEgress: ["https://api.github.com"],
      enforced: true,
      bindingId: "bind-1",
    });
    // resolveHandle still returns the plaintext for the substitution path.
    expect(resolveHandle(RUN_A, handle)).toBe(SECRET);
  });

  it("defaults to log-only + empty allowlist when no capture is given (legacy path)", () => {
    const handle = mintHandle(RUN_A, SECRET);
    const rec = getHandleRecord(RUN_A, handle);
    expect(rec).toMatchObject({ enforced: false, allowedEgress: [], bindingId: null });
  });
});

describe("collectHandleTokens — enumerate without resolving", () => {
  it("finds every distinct handle across nested leaves", () => {
    const h1 = mintHandle(RUN_A, SECRET, { allowedEgress: [], enforced: true, bindingId: "b1" });
    const h2 = mintHandle(RUN_A, "other-secret", { allowedEgress: [], enforced: true, bindingId: "b2" });
    const tokens = collectHandleTokens({
      header: `Bearer ${h1}`,
      nested: [{ a: `x=${h2}` }, { b: `dup=${h1}` }],
      plain: "no handle here",
    });
    expect(new Set(tokens)).toEqual(new Set([h1, h2]));
  });

  it("returns empty for handle-free input", () => {
    expect(collectHandleTokens({ a: "plain", b: 1, c: null })).toEqual([]);
  });
});

describe("EG3 — purgeHandlesByBinding invalidates live handles on revocation", () => {
  it("purges only the targeted binding's handles, across runs", () => {
    const a1 = mintHandle(RUN_A, SECRET, { allowedEgress: [], enforced: true, bindingId: "bind-X" });
    const a2 = mintHandle(RUN_A, SECRET, { allowedEgress: [], enforced: true, bindingId: "bind-Y" });
    const b1 = mintHandle(RUN_B, SECRET, { allowedEgress: [], enforced: true, bindingId: "bind-X" });

    const purged = purgeHandlesByBinding("bind-X");
    expect(purged).toBe(2);
    // bind-X handles are gone (a now-removed destination cannot keep receiving plaintext).
    expect(getHandleRecord(RUN_A, a1)).toBeUndefined();
    expect(getHandleRecord(RUN_B, b1)).toBeUndefined();
    // bind-Y handle survives.
    expect(getHandleRecord(RUN_A, a2)?.value).toBe(SECRET);
  });

  it("is idempotent and a no-op for an unknown binding", () => {
    mintHandle(RUN_A, SECRET, { allowedEgress: [], enforced: true, bindingId: "bind-Z" });
    expect(purgeHandlesByBinding("nope")).toBe(0);
    expect(purgeHandlesByBinding("bind-Z")).toBe(1);
    expect(purgeHandlesByBinding("bind-Z")).toBe(0);
  });
});
