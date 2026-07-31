import { describe, expect, it } from "vitest";
import {
  buildHeartbeatRunStopMetadata,
  mergeHeartbeatRunStopMetadata,
  resolveAgentStatusAfterRun,
  resolveHeartbeatRunTimeoutPolicy,
} from "./heartbeat-stop-metadata.js";

describe("heartbeat stop metadata", () => {
  it("keeps local coding adapters at no timeout by default", () => {
    for (const adapterType of [
      "codex_local",
      "claude_local",
      "cursor",
      "gemini_local",
      "opencode_local",
      "pi_local",
      "process",
    ]) {
      expect(resolveHeartbeatRunTimeoutPolicy(adapterType, {})).toEqual({
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "default",
      });
    }
  });

  it("records configured timeout policy and timeout stop reason", () => {
    const metadata = buildHeartbeatRunStopMetadata({
      adapterType: "codex_local",
      adapterConfig: { timeoutSec: 45 },
      outcome: "timed_out",
      errorCode: "timeout",
      errorMessage: "Timed out after 45s",
    });

    expect(metadata).toEqual({
      effectiveTimeoutSec: 45,
      timeoutConfigured: true,
      timeoutSource: "config",
      stopReason: "timeout",
      timeoutFired: true,
    });
  });

  // A dirty teardown used to park the agent in `error` on the back of a run
  // that had already done its work. The regression guard in the second half
  // matters more than the fix — real failures must still park the agent.
  it("leaves the agent idle after a dirty teardown but still parks it after a real failure", () => {
    expect(resolveAgentStatusAfterRun({ outcome: "succeeded_dirty", runningRunCount: 0 })).toBe("idle");
    expect(resolveAgentStatusAfterRun({ outcome: "succeeded", runningRunCount: 0 })).toBe("idle");
    expect(resolveAgentStatusAfterRun({ outcome: "cancelled", runningRunCount: 0 })).toBe("idle");

    expect(resolveAgentStatusAfterRun({ outcome: "failed", runningRunCount: 0 })).toBe("error");
    expect(resolveAgentStatusAfterRun({ outcome: "timed_out", runningRunCount: 0 })).toBe("error");

    expect(resolveAgentStatusAfterRun({ outcome: "failed", runningRunCount: 1 })).toBe("running");
  });

  // PLA-1865: a quota/upstream-transient failure is not the agent's fault — the
  // run stays `failed` (the work really did not happen) but the agent must stay
  // `idle` so it wakes again once `retryNotBefore` elapses. A genuine failure
  // (no errorFamily, or a distinct family like a real crash) must still park
  // the agent in `error`, exactly as the first half of this file's guard
  // requires — this is the same predicate, pinned in both directions.
  it("leaves the agent idle after a transient-upstream/quota failure but still parks it after a genuine one", () => {
    expect(
      resolveAgentStatusAfterRun({ outcome: "failed", runningRunCount: 0, errorFamily: "transient_upstream" }),
    ).toBe("idle");

    expect(resolveAgentStatusAfterRun({ outcome: "failed", runningRunCount: 0, errorFamily: null })).toBe("error");
    expect(resolveAgentStatusAfterRun({ outcome: "failed", runningRunCount: 0 })).toBe("error");
    expect(
      resolveAgentStatusAfterRun({ outcome: "timed_out", runningRunCount: 0, errorFamily: "transient_upstream" }),
    ).toBe("error");
  });

  // A dirty teardown after a clean result must read as a completion with a
  // diagnostic tag, not as an adapter failure.
  it("separates a dirty teardown from an adapter failure", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "succeeded_dirty",
        errorCode: "dirty_exit",
        errorMessage: "Claude reported a successful result but the process exited with code 1",
      }).stopReason,
    ).toBe("completed_dirty_exit");

    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "adapter_failed",
        errorMessage: "Claude run failed",
      }).stopReason,
    ).toBe("adapter_failed");
  });

  it("distinguishes budget cancellation from manual cancellation", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled due to budget pause",
      }).stopReason,
    ).toBe("budget_paused");

    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled by control plane",
      }).stopReason,
    ).toBe("cancelled");
  });

  it("records graceful interruption separately from failure", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "interrupted",
        errorCode: "server_shutdown_interrupted",
        errorMessage: "Interrupted by graceful server shutdown",
      }).stopReason,
    ).toBe("interrupted");
  });

  it("normalizes max-turn exhaustion stop reasons", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "turn_limit_exhausted",
        errorMessage: "turn limit reached",
      }).stopReason,
    ).toBe("max_turns_exhausted");

    const merged = mergeHeartbeatRunStopMetadata(
      { stopReason: "turn_limit_exhausted" },
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "adapter_failed",
      }),
    );
    expect(merged.stopReason).toBe("max_turns_exhausted");
  });

  it("prioritizes succeeded outcome over inconsistent max-turn error metadata", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "succeeded",
        errorCode: "max_turns_exhausted",
      }).stopReason,
    ).toBe("completed");
  });

  it("preserves existing result fields when merging stop metadata", () => {
    const result = mergeHeartbeatRunStopMetadata(
      { summary: "done" },
      buildHeartbeatRunStopMetadata({
        adapterType: "openclaw_gateway",
        adapterConfig: {},
        outcome: "succeeded",
      }),
    );

    expect(result).toMatchObject({
      summary: "done",
      stopReason: "completed",
      effectiveTimeoutSec: 120,
      timeoutConfigured: true,
      timeoutSource: "default",
      timeoutFired: false,
    });
  });
});
