import { describe, expect, it } from "vitest";
import {
  isProviderAdmissionFailureRun,
  type ProviderAdmissionFailureRunShape,
} from "../services/provider-admission-failure.ts";

function run(shape: Partial<ProviderAdmissionFailureRunShape>): ProviderAdmissionFailureRunShape {
  return {
    status: "failed",
    errorCode: "claude_transient_upstream",
    resultJson: { errorFamily: "transient_upstream" },
    usageJson: null,
    ...shape,
  };
}

describe("isProviderAdmissionFailureRun", () => {
  it("classifies a bare 429-class transient failure with no usage as an admission failure", () => {
    expect(isProviderAdmissionFailureRun(run({}))).toBe(true);
  });

  it("classifies via errorCode alone when resultJson carries no family", () => {
    expect(
      isProviderAdmissionFailureRun(run({ errorCode: "codex_transient_upstream", resultJson: null })),
    ).toBe(true);
    expect(
      isProviderAdmissionFailureRun(run({ errorCode: "claude_transient_upstream", resultJson: null })),
    ).toBe(true);
  });

  it("classifies via resultJson.errorFamily when the errorCode is generic", () => {
    expect(
      isProviderAdmissionFailureRun(run({ errorCode: "adapter_failed", resultJson: { errorFamily: "transient_upstream" } })),
    ).toBe(true);
  });

  it("rejects successful runs regardless of transient metadata", () => {
    expect(isProviderAdmissionFailureRun(run({ status: "succeeded" }))).toBe(false);
    expect(isProviderAdmissionFailureRun(run({ status: "scheduled_retry" }))).toBe(false);
  });

  it("rejects non-transient error codes (no behavior change for non-429 classes)", () => {
    expect(
      isProviderAdmissionFailureRun(run({ errorCode: "claude_auth_required", resultJson: null })),
    ).toBe(false);
    expect(isProviderAdmissionFailureRun(run({ errorCode: "timeout", resultJson: null }))).toBe(false);
    expect(
      isProviderAdmissionFailureRun(run({ errorCode: "adapter_failed", resultJson: null })),
    ).toBe(false);
  });

  it("rejects a transient failure that billed real model work", () => {
    expect(
      isProviderAdmissionFailureRun(
        run({ resultJson: { errorFamily: "transient_upstream", total_cost_usd: 0.42 } }),
      ),
    ).toBe(false);
    expect(
      isProviderAdmissionFailureRun(
        run({
          resultJson: { errorFamily: "transient_upstream", total_cost_usd: "0.42" },
        }),
      ),
    ).toBe(false);
    expect(
      isProviderAdmissionFailureRun(
        run({ usageJson: { inputTokens: 1200, outputTokens: 64 } }),
      ),
    ).toBe(false);
    expect(
      isProviderAdmissionFailureRun(
        run({ usageJson: { input_tokens: 10, output_tokens: 0 } }),
      ),
    ).toBe(false);
  });

  it("accepts explicit zero-cost transient failures", () => {
    expect(
      isProviderAdmissionFailureRun(
        run({
          resultJson: { errorFamily: "transient_upstream", total_cost_usd: 0 },
          usageJson: { inputTokens: 0, outputTokens: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      isProviderAdmissionFailureRun(
        run({
          resultJson: { errorFamily: "transient_upstream", total_cost_usd: "0.00" },
        }),
      ),
    ).toBe(true);
  });
});
