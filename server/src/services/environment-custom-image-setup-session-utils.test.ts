import { describe, expect, it } from "vitest";
import {
  readCustomImageSetupSessionCompanyId,
  readFutureDate,
  readNullableDate,
  requireFutureCustomImageSetupExpiry,
} from "./environment-custom-image-setup-session-utils.js";

describe("readCustomImageSetupSessionCompanyId", () => {
  it("returns null when metadata is missing", () => {
    expect(readCustomImageSetupSessionCompanyId({})).toBeNull();
    expect(readCustomImageSetupSessionCompanyId({ metadata: null })).toBeNull();
  });

  it("returns null when setupRpcCompanyId is absent or not a string", () => {
    expect(readCustomImageSetupSessionCompanyId({ metadata: {} })).toBeNull();
    expect(readCustomImageSetupSessionCompanyId({ metadata: { setupRpcCompanyId: 123 } })).toBeNull();
  });

  it("returns null for the instance-level sentinel value, even with surrounding whitespace", () => {
    expect(
      readCustomImageSetupSessionCompanyId({ metadata: { setupRpcCompanyId: "instance" } }),
    ).toBeNull();
    expect(
      readCustomImageSetupSessionCompanyId({ metadata: { setupRpcCompanyId: "  instance  " } }),
    ).toBeNull();
  });

  it("returns null for an empty or whitespace-only value", () => {
    expect(readCustomImageSetupSessionCompanyId({ metadata: { setupRpcCompanyId: "" } })).toBeNull();
    expect(
      readCustomImageSetupSessionCompanyId({ metadata: { setupRpcCompanyId: "   " } }),
    ).toBeNull();
  });

  it("returns the trimmed company id for a real value", () => {
    expect(
      readCustomImageSetupSessionCompanyId({ metadata: { setupRpcCompanyId: "  company-1  " } }),
    ).toBe("company-1");
  });
});

describe("readNullableDate", () => {
  it("returns null for falsy values", () => {
    expect(readNullableDate(null)).toBeNull();
    expect(readNullableDate(undefined)).toBeNull();
    expect(readNullableDate("")).toBeNull();
  });

  it("returns a Date instance unchanged", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect(readNullableDate(date)).toBe(date);
  });

  it("parses a valid date string", () => {
    expect(readNullableDate("2026-01-01T00:00:00Z")).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  it("returns null for an invalid date string", () => {
    expect(readNullableDate("not-a-date")).toBeNull();
  });

  it("returns null for a truthy value that is neither a Date nor a string", () => {
    expect(readNullableDate(12345)).toBeNull();
    expect(readNullableDate({})).toBeNull();
  });
});

describe("readFutureDate", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("returns the date when it is strictly after now", () => {
    const future = new Date("2026-01-02T00:00:00Z");
    expect(readFutureDate(future, now)).toEqual(future);
  });

  it("returns null when the date is in the past", () => {
    expect(readFutureDate(new Date("2025-12-31T00:00:00Z"), now)).toBeNull();
  });

  it("returns null when the date exactly equals now (not strictly future)", () => {
    expect(readFutureDate(new Date(now), now)).toBeNull();
  });

  it("returns null for an invalid or missing date", () => {
    expect(readFutureDate("not-a-date", now)).toBeNull();
    expect(readFutureDate(null, now)).toBeNull();
    expect(readFutureDate(undefined, now)).toBeNull();
  });
});

describe("requireFutureCustomImageSetupExpiry", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("returns the expiry date when it is in the future", () => {
    const future = new Date("2026-01-02T00:00:00Z");
    expect(requireFutureCustomImageSetupExpiry({ expiresAt: future }, now)).toEqual(future);
  });

  it("throws a 409 conflict when the session has expired", () => {
    expect(() =>
      requireFutureCustomImageSetupExpiry({ expiresAt: new Date("2025-12-31T00:00:00Z") }, now),
    ).toThrow("Environment customImage setup session has expired.");
  });

  it("throws a 409 conflict when expiresAt is null", () => {
    expect(() => requireFutureCustomImageSetupExpiry({ expiresAt: null }, now)).toThrow(
      "Environment customImage setup session has expired.",
    );
  });
});
