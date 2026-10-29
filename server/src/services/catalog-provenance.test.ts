import { describe, expect, it } from "vitest";
import { readCatalogStringList, readPortableCatalogProvenance } from "./catalog-provenance.js";

describe("readCatalogStringList", () => {
  it("returns a trimmed array for a valid string list", () => {
    expect(readCatalogStringList([" a ", "b"])).toEqual(["a", "b"]);
  });

  it("returns an empty array for an empty input array", () => {
    expect(readCatalogStringList([])).toEqual([]);
  });

  it("returns null for a non-array value", () => {
    expect(readCatalogStringList("not-an-array")).toBeNull();
    expect(readCatalogStringList(null)).toBeNull();
    expect(readCatalogStringList(undefined)).toBeNull();
  });

  it("returns null when any entry is not a non-empty string", () => {
    expect(readCatalogStringList(["a", 1])).toBeNull();
    expect(readCatalogStringList(["a", ""])).toBeNull();
    expect(readCatalogStringList(["a", "   "])).toBeNull();
    expect(readCatalogStringList(["a", null])).toBeNull();
  });
});

describe("readPortableCatalogProvenance", () => {
  it("returns null when metadata is null", () => {
    expect(readPortableCatalogProvenance(null)).toBeNull();
  });

  it("returns null when metadata.paperclip is missing or not a record", () => {
    expect(readPortableCatalogProvenance({})).toBeNull();
    expect(readPortableCatalogProvenance({ paperclip: "not-a-record" })).toBeNull();
    expect(readPortableCatalogProvenance({ paperclip: ["array"] })).toBeNull();
  });

  it("returns null when paperclip.catalog is missing or not a record", () => {
    expect(readPortableCatalogProvenance({ paperclip: {} })).toBeNull();
    expect(readPortableCatalogProvenance({ paperclip: { catalog: "not-a-record" } })).toBeNull();
  });

  it("derives sourceRef from sourceRef when present, and mirrors it into originHash when absent", () => {
    const result = readPortableCatalogProvenance({
      paperclip: { catalog: { sourceRef: "ref-123" } },
    });
    expect(result).toEqual({
      sourceRef: "ref-123",
      metadata: { sourceKind: "catalog", originHash: "ref-123" },
    });
  });

  it("falls back to originHash for sourceRef when sourceRef is absent", () => {
    const result = readPortableCatalogProvenance({
      paperclip: { catalog: { originHash: "hash-456" } },
    });
    expect(result?.sourceRef).toBe("hash-456");
    expect(result?.metadata.originHash).toBe("hash-456");
  });

  it("keeps the top-level sourceRef distinct from normalized.originHash when both fields are present and differ", () => {
    const result = readPortableCatalogProvenance({
      paperclip: { catalog: { sourceRef: "ref-123", originHash: "hash-456" } },
    });
    expect(result?.sourceRef).toBe("ref-123");
    expect(result?.metadata.originHash).toBe("hash-456");
  });

  it("uses the explicit canonicalKey for skillKey, overriding the catalog's own skillKey", () => {
    const result = readPortableCatalogProvenance(
      { paperclip: { catalog: { skillKey: "catalog-key" } } },
      "canonical-key",
    );
    expect(result?.metadata.skillKey).toBe("canonical-key");
  });

  it("falls back to the catalog's own skillKey when no canonicalKey is given", () => {
    const result = readPortableCatalogProvenance({
      paperclip: { catalog: { skillKey: "catalog-key" } },
    });
    expect(result?.metadata.skillKey).toBe("catalog-key");
  });

  it("omits skillKey entirely when neither canonicalKey nor a catalog skillKey is present", () => {
    const result = readPortableCatalogProvenance({ paperclip: { catalog: { packageName: "x" } } });
    expect(result?.metadata).not.toHaveProperty("skillKey");
  });

  it("includes a valid auditCodes list and omits it when malformed", () => {
    const withCodes = readPortableCatalogProvenance({
      paperclip: { catalog: { auditCodes: ["a1", "a2"] } },
    });
    expect(withCodes?.metadata.auditCodes).toEqual(["a1", "a2"]);

    const withMalformedCodes = readPortableCatalogProvenance({
      paperclip: { catalog: { auditCodes: ["a1", 2] } },
    });
    expect(withMalformedCodes?.metadata).not.toHaveProperty("auditCodes");
  });

  it("omits an empty or non-string provenance field instead of including an empty value", () => {
    const result = readPortableCatalogProvenance({
      paperclip: { catalog: { packageName: "  ", packageVersion: 1.2 } },
    });
    expect(result?.metadata).not.toHaveProperty("packageName");
    expect(result?.metadata).not.toHaveProperty("packageVersion");
  });

  it("always sets sourceKind to 'catalog'", () => {
    const result = readPortableCatalogProvenance({ paperclip: { catalog: { packageName: "x" } } });
    expect(result?.metadata.sourceKind).toBe("catalog");
  });
});
