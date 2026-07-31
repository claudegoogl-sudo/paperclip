import { describe, expect, it, vi } from "vitest";
import {
  ConfigAgreementDeniedError,
  deepEqualStructural,
  getAgreedOrDeny,
  type ConfigAgreementRow,
} from "../services/plugin-config-agreement.js";

function makeLogger() {
  return { error: vi.fn(), warn: vi.fn() };
}

function rows(...rows: ConfigAgreementRow[]): ConfigAgreementRow[] {
  return rows;
}

describe("deepEqualStructural", () => {
  it("treats differently key-ordered objects as equal (PLA-1942 A1 — never JSON.stringify compare)", () => {
    const a = { z: 1, a: { nested: true, other: 2 } };
    const b = { a: { other: 2, nested: true }, z: 1 };
    expect(deepEqualStructural(a, b)).toBe(true);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("distinguishes arrays by order and length", () => {
    expect(deepEqualStructural([1, 2], [2, 1])).toBe(false);
    expect(deepEqualStructural([1, 2], [1, 2])).toBe(true);
    expect(deepEqualStructural([1, 2], [1, 2, 3])).toBe(false);
  });

  it("treats objects with a differing key set as unequal", () => {
    expect(deepEqualStructural({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe("getAgreedOrDeny", () => {
  it("returns {} for zero owning rows and still fires onResolve", async () => {
    const onResolve = vi.fn();
    const result = await getAgreedOrDeny({
      pluginId: "plugin-1",
      pluginKey: "test.plugin",
      listConfigRows: async () => rows(),
      secretRefPaths: new Set(),
      logger: makeLogger(),
      onDeny: vi.fn(),
      onResolve,
    });
    expect(result).toEqual({});
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("returns the sole row's config verbatim for a single owning row", async () => {
    const result = await getAgreedOrDeny({
      pluginId: "plugin-1",
      pluginKey: "test.plugin",
      listConfigRows: async () => rows({ companyId: "company-a", configJson: { apiKey: "k1" } }),
      secretRefPaths: new Set(),
      logger: makeLogger(),
      onDeny: vi.fn(),
    });
    expect(result).toEqual({ apiKey: "k1" });
  });

  it("resolves when every owning row agrees on all non-secret-ref fields", async () => {
    const onResolve = vi.fn();
    const result = await getAgreedOrDeny({
      pluginId: "plugin-1",
      pluginKey: "test.plugin",
      listConfigRows: async () =>
        rows(
          { companyId: "company-a", configJson: { mode: "prod", limit: 5 } },
          { companyId: "company-b", configJson: { mode: "prod", limit: 5 } },
          { companyId: "company-c", configJson: { mode: "prod", limit: 5 } },
        ),
      secretRefPaths: new Set(),
      logger: makeLogger(),
      onDeny: vi.fn(),
      onResolve,
    });
    expect(result).toEqual({ mode: "prod", limit: 5 });
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("A3.1 regression anchor: N rows carrying the SAME secret-ref value union it in, not drop it", async () => {
    // Migration 0164 fans an instance-wide row's secret-ref UUID out to every
    // company row verbatim, so post-migration every owning row is non-null
    // with the IDENTICAL value. A "row count > 1 => conflict" rule (the bug
    // this test pins against) would misread that as an N-way disagreement
    // and drop the field, unfixing PLA-1870. The correct rule is "at most one
    // DISTINCT non-null value" — 3 rows, 1 distinct value, union it in.
    const secretRefId = "11111111-1111-4111-8111-111111111111";
    const result = await getAgreedOrDeny({
      pluginId: "plugin-1",
      pluginKey: "test.plugin",
      listConfigRows: async () =>
        rows(
          { companyId: "company-a", configJson: { mode: "prod", githubPatSecretId: secretRefId } },
          { companyId: "company-b", configJson: { mode: "prod", githubPatSecretId: secretRefId } },
          { companyId: "company-c", configJson: { mode: "prod", githubPatSecretId: secretRefId } },
        ),
      secretRefPaths: new Set(["githubPatSecretId"]),
      logger: makeLogger(),
      onDeny: vi.fn(),
    });
    expect(result).toEqual({ mode: "prod", githubPatSecretId: secretRefId });
  });

  it("drops a secret-ref field silently when every row has it null/absent (0 distinct)", async () => {
    const result = await getAgreedOrDeny({
      pluginId: "plugin-1",
      pluginKey: "test.plugin",
      listConfigRows: async () =>
        rows(
          { companyId: "company-a", configJson: { mode: "prod" } },
          { companyId: "company-b", configJson: { mode: "prod", githubPatSecretId: null } },
        ),
      secretRefPaths: new Set(["githubPatSecretId"]),
      logger: makeLogger(),
      onDeny: vi.fn(),
    });
    expect(result).toEqual({ mode: "prod" });
  });

  it("drops just the diverging secret-ref field (2+ distinct values) with a warning, without denying the whole config", async () => {
    const logger = makeLogger();
    const onDeny = vi.fn();
    const result = await getAgreedOrDeny({
      pluginId: "plugin-1",
      pluginKey: "test.plugin",
      listConfigRows: async () =>
        rows(
          { companyId: "company-a", configJson: { mode: "prod", githubPatSecretId: "secret-a" } },
          { companyId: "company-b", configJson: { mode: "prod", githubPatSecretId: "secret-b" } },
        ),
      secretRefPaths: new Set(["githubPatSecretId"]),
      logger,
      onDeny,
    });
    expect(result).toEqual({ mode: "prod" });
    expect(onDeny).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatchObject({
      pluginId: "plugin-1",
      pluginKey: "test.plugin",
      path: "githubPatSecretId",
    });
  });

  it("denies and reports disagreeing top-level key names when non-secret-ref fields diverge", async () => {
    const logger = makeLogger();
    const onDeny = vi.fn();
    await expect(
      getAgreedOrDeny({
        pluginId: "plugin-1",
        pluginKey: "test.plugin",
        listConfigRows: async () =>
          rows(
            { companyId: "company-a", configJson: { mode: "prod", limit: 5 } },
            { companyId: "company-b", configJson: { mode: "staging", limit: 5 } },
          ),
        secretRefPaths: new Set(),
        logger,
        onDeny,
      }),
    ).rejects.toBeInstanceOf(ConfigAgreementDeniedError);

    // A3.4a: full detail — pluginId, company ids, and disagreeing top-level
    // KEY NAMES only — goes to the host-side log, never values.
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload, message] = logger.error.mock.calls[0]!;
    expect(payload).toMatchObject({
      pluginId: "plugin-1",
      pluginKey: "test.plugin",
      companyIds: expect.arrayContaining(["company-a", "company-b"]),
      disagreeingKeys: ["mode"],
    });
    expect(JSON.stringify(payload)).not.toContain("prod");
    expect(JSON.stringify(payload)).not.toContain("staging");
    expect(message).toContain("owning config rows disagree");

    // onDeny receives the same tenant-neutral shape (key names + company ids)
    // — the caller (plugin-host-services.ts) is what decides to drop the
    // company ids before writing to `plugins.lastError` (A2).
    expect(onDeny).toHaveBeenCalledWith({
      disagreeingKeys: ["mode"],
      companyIds: expect.arrayContaining(["company-a", "company-b"]),
    });
  });

  it("never invokes onResolve when denying", async () => {
    const onResolve = vi.fn();
    await expect(
      getAgreedOrDeny({
        pluginId: "plugin-1",
        pluginKey: "test.plugin",
        listConfigRows: async () =>
          rows(
            { companyId: "company-a", configJson: { mode: "prod" } },
            { companyId: "company-b", configJson: { mode: "staging" } },
          ),
        secretRefPaths: new Set(),
        logger: makeLogger(),
        onDeny: vi.fn(),
        onResolve,
      }),
    ).rejects.toBeInstanceOf(ConfigAgreementDeniedError);
    expect(onResolve).not.toHaveBeenCalled();
  });
});
