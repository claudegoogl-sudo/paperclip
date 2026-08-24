import { describe, expect, it } from "vitest";

import { resolveServerTestMaxWorkers } from "../config/server-test-max-workers.js";

describe("resolveServerTestMaxWorkers", () => {
  // 4-vCPU box: default = max(1, min(3, floor(4/2))) = 2
  const availableParallelism = 4;

  it("falls back to the clamped default when unset", () => {
    expect(resolveServerTestMaxWorkers({ override: undefined, availableParallelism })).toBe(2);
  });

  it("honors an in-range override of 1", () => {
    expect(resolveServerTestMaxWorkers({ override: "1", availableParallelism })).toBe(1);
  });

  it("honors an in-range override of 3", () => {
    expect(resolveServerTestMaxWorkers({ override: "3", availableParallelism })).toBe(3);
  });

  it("falls back to the default on 0", () => {
    expect(resolveServerTestMaxWorkers({ override: "0", availableParallelism })).toBe(2);
  });

  it("falls back to the default on non-numeric input", () => {
    expect(resolveServerTestMaxWorkers({ override: "abc", availableParallelism })).toBe(2);
  });

  it("clamps an override far above the machine's parallelism", () => {
    expect(resolveServerTestMaxWorkers({ override: "64", availableParallelism })).toBe(4);
  });

  it("passes through an override that exactly matches parallelism", () => {
    expect(resolveServerTestMaxWorkers({ override: "4", availableParallelism })).toBe(4);
  });

  it("clamps a large override on a larger CI-sized box", () => {
    expect(
      resolveServerTestMaxWorkers({ override: "64", availableParallelism: 16 }),
    ).toBe(16);
  });

  it("honors an override within range on a larger CI-sized box", () => {
    expect(
      resolveServerTestMaxWorkers({ override: "16", availableParallelism: 16 }),
    ).toBe(16);
  });

  it("falls back to the default on a negative override", () => {
    expect(resolveServerTestMaxWorkers({ override: "-5", availableParallelism })).toBe(2);
  });
});
