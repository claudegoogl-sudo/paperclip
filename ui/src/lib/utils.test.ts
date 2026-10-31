import { describe, expect, it } from "vitest";
import { asBoolean, asFiniteNumber, asObject, cn, formatCents, formatNumber } from "./utils";

describe("cn", () => {
  it("joins multiple string class names", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("drops falsy conditional args", () => {
    expect(cn("a", false && "b", undefined, null, "", "c")).toBe("a c");
  });

  it("flattens arrays of class names", () => {
    expect(cn(["a", "b"], "c")).toBe("a b c");
  });

  it("merges conflicting tailwind utility classes, keeping the last one", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("supports the clsx object form for conditional classes", () => {
    expect(cn({ a: true, b: false, c: true })).toBe("a c");
  });
});

describe("asObject", () => {
  it("returns the value when it is a plain object", () => {
    const value = { foo: "bar" };
    expect(asObject(value)).toBe(value);
  });

  it("returns an empty object for null", () => {
    expect(asObject(null)).toEqual({});
  });

  it("returns an empty object for arrays", () => {
    expect(asObject([1, 2, 3])).toEqual({});
  });

  it("returns an empty object for primitives", () => {
    expect(asObject("string")).toEqual({});
    expect(asObject(42)).toEqual({});
    expect(asObject(undefined)).toEqual({});
    expect(asObject(true)).toEqual({});
  });
});

describe("asBoolean", () => {
  it("returns the value when it is a boolean", () => {
    expect(asBoolean(true, false)).toBe(true);
    expect(asBoolean(false, true)).toBe(false);
  });

  it("returns the fallback for non-boolean values", () => {
    expect(asBoolean("true", false)).toBe(false);
    expect(asBoolean(1, false)).toBe(false);
    expect(asBoolean(null, true)).toBe(true);
    expect(asBoolean(undefined, true)).toBe(true);
  });
});

describe("asFiniteNumber", () => {
  it("returns the value when it is a finite number", () => {
    expect(asFiniteNumber(42, 0)).toBe(42);
    expect(asFiniteNumber(0, 99)).toBe(0);
    expect(asFiniteNumber(-5, 0)).toBe(-5);
  });

  it("returns the fallback for NaN and Infinity", () => {
    expect(asFiniteNumber(NaN, 7)).toBe(7);
    expect(asFiniteNumber(Infinity, 7)).toBe(7);
    expect(asFiniteNumber(-Infinity, 7)).toBe(7);
  });

  it("returns the fallback for non-number values", () => {
    expect(asFiniteNumber("42", 0)).toBe(0);
    expect(asFiniteNumber(null, 0)).toBe(0);
    expect(asFiniteNumber(undefined, 0)).toBe(0);
  });
});

describe("formatCents", () => {
  it("formats a typical cents value as dollars with two decimals", () => {
    expect(formatCents(120_000)).toBe("$1,200.00");
  });

  it("formats zero", () => {
    expect(formatCents(0)).toBe("$0.00");
  });

  it("formats negative amounts", () => {
    // ICU versions differ on sign placement.
    expect(formatCents(-500)).toMatch(/^(-\$5\.00|\$-5\.00)$/);
  });

  it("formats sub-dollar amounts", () => {
    expect(formatCents(150)).toBe("$1.50");
  });

  it("rounds fractional cents to two decimal places", () => {
    expect(formatCents(1)).toBe("$0.01");
    expect(formatCents(1234.5)).toBe("$12.35");
  });

  it("adds thousands separators for large amounts", () => {
    expect(formatCents(123_456_789)).toBe("$1,234,567.89");
  });
});

describe("formatNumber", () => {
  it("formats a typical integer with thousands separators", () => {
    expect(formatNumber(1234)).toBe("1,234");
  });

  it("formats zero", () => {
    expect(formatNumber(0)).toBe("0");
  });

  it("formats negative numbers", () => {
    expect(formatNumber(-42)).toBe("-42");
  });

  it("formats large numbers with multiple separators", () => {
    expect(formatNumber(1_000_000)).toBe("1,000,000");
  });

  it("formats numbers below the thousands boundary without a separator", () => {
    expect(formatNumber(999)).toBe("999");
  });
});
