import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards the default: both always-on loops start unless the test-only switch is exactly "1".
describe("always-on loops default boot", () => {
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  it("gates both loops only on the test-only switch being === \"1\"", () => {
    expect(src).toContain('process.env.PAPERCLIP_TEST_DISABLE_ALWAYS_ON_LOOPS === "1"');
    expect(src).toMatch(/else \{\s*startEgressPostureSweep\(/);
    expect(src).toContain("if (!alwaysOnLoopsDisabledForTest) startTaskBridgeRenewalSweep(db as any);");
  });
  it("does not set the switch anywhere outside test helpers", () => {
    expect(src).not.toMatch(/PAPERCLIP_TEST_DISABLE_ALWAYS_ON_LOOPS\s*=\s*["']1/);
  });
});
