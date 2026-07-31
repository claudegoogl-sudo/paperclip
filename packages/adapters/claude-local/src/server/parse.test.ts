import { describe, expect, it } from "vitest";
import {
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeRefusalResult,
  isClaudeUnknownSessionError,
  isClaudeImageProcessingError,
  isClaudePreTurnRateLimitResult,
} from "./parse.js";

const SESSION_LIMIT_RESULT = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  num_turns: 1,
  duration_api_ms: 0,
  total_cost_usd: 0,
  api_error_status: 429,
  result: "You've hit your session limit · resets 1:50pm (UTC)",
} satisfies Record<string, unknown>;

describe("detectClaudeLoginRequired", () => {
  it("classifies Claude's invalid API key login prompt as auth required", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "",
        stderr: "Invalid API key · Please run /login",
      }),
    ).toEqual({ requiresLogin: true, loginUrl: null });
  });

  it("does not classify a bare invalid API key as the Claude login flow", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "",
        stderr: "Invalid API key",
      }).requiresLogin,
    ).toBe(false);
  });
});

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("classifies the session-limit failure as transient", () => {
    expect(isClaudeTransientUpstreamError({ parsed: SESSION_LIMIT_RESULT })).toBe(true);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });

  it("does not classify poisoned previous_message_id errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          subtype: "success",
          is_error: true,
          result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
        },
      }),
    ).toBe(false);
  });
});

describe("isClaudePoisonedPreviousMessageIdError", () => {
  it("detects the previous_message_id 400 error in the result field", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "",
        errors: [{ message: "400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)" }],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudePoisonedPreviousMessageIdError({})).toBe(false);
  });
});

describe("isClaudeRefusalResult", () => {
  it("detects stop_reason: refusal even on a clean (is_error=false) result", () => {
    expect(
      isClaudeRefusalResult({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "refusal",
        result: "",
      }),
    ).toBe(true);
  });

  it("detects the camelCase stopReason variant", () => {
    expect(isClaudeRefusalResult({ stopReason: "refusal" })).toBe(true);
  });

  it("detects subtype: model_refusal", () => {
    expect(
      isClaudeRefusalResult({ subtype: "model_refusal", is_error: false }),
    ).toBe(true);
  });

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    expect(isClaudeRefusalResult({ stop_reason: "  Refusal " })).toBe(true);
  });

  it("returns false for ordinary successful turns", () => {
    expect(
      isClaudeRefusalResult({
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        result: "Here is your answer.",
      }),
    ).toBe(false);
  });

  it("returns false for max-turns and other stop reasons", () => {
    expect(isClaudeRefusalResult({ stop_reason: "max_turns" })).toBe(false);
    expect(isClaudeRefusalResult({ subtype: "error_max_turns" })).toBe(false);
  });

  it("returns false for null/empty parsed result", () => {
    expect(isClaudeRefusalResult(null)).toBe(false);
    expect(isClaudeRefusalResult({})).toBe(false);
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects the legacy 'no conversation found' message", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Error: No conversation found with session id 1234",
      }),
    ).toBe(true);
  });

  it("detects 'session ... not found' style errors", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [{ message: "Session abc123 not found" }],
      }),
    ).toBe(true);
  });

  it("detects '--resume requires a valid session' validation error from non-UUID input", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [
          {
            message:
              'Error: --resume requires a valid session ID or session title when used with --print. Usage: claude -p --resume <session-id|title>. Provided value "ses_268c2d0a5ffemYbEaeG7c86Uvo" is not a UUID and does not match any session title.',
          },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated error text", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Some other failure",
        errors: [{ message: "Network timeout" }],
      }),
    ).toBe(false);
  });
});

describe("isClaudeImageProcessingError", () => {
  it("detects the 'Could not process image' 400 error in the result field", () => {
    expect(
      isClaudeImageProcessingError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 Could not process image: image source URL has expired",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "",
        errors: [{ message: "400 Could not process image" }],
      }),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "could not process image attached to message",
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudeImageProcessingError({})).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });

  it("parses the session-limit reset time later the same day", () => {
    const now = new Date("2026-07-26T12:30:00.000Z");
    expect(
      extractClaudeRetryNotBefore({ parsed: SESSION_LIMIT_RESULT }, now)?.toISOString(),
    ).toBe("2026-07-26T13:50:00.000Z");
  });

  it("rolls the session-limit reset time to tomorrow when it has already passed today", () => {
    const now = new Date("2026-07-26T14:30:00.000Z");
    expect(
      extractClaudeRetryNotBefore({ parsed: SESSION_LIMIT_RESULT }, now)?.toISOString(),
    ).toBe("2026-07-27T13:50:00.000Z");
  });

  it("resolves a session-limit reset time in a non-UTC zone", () => {
    const now = new Date("2026-07-26T12:30:00.000Z");
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "You've hit your session limit · resets 1:50pm (America/New_York)" },
        now,
      )?.toISOString(),
    ).toBe("2026-07-26T17:50:00.000Z");
  });

  it("returns null for a session limit whose reset time is unparseable", () => {
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "You've hit your session limit · resets soon" },
        new Date("2026-07-26T12:30:00.000Z"),
      ),
    ).toBeNull();
  });

  // PLA-1930: exact live strings observed in `heartbeat_runs.result_json.result`
  // during the 2026-07-31 usage-limit storm. The `·` separator below is the real
  // U+00B7 middle-dot character the CLI emits, not a hyphen.
  it("parses the live dated weekly-limit string to the exact absolute instant", () => {
    const now = new Date("2026-07-30T10:00:00.000Z");
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "You've hit your weekly limit · resets Jul 31, 8am (UTC)" },
        now,
      )?.toISOString(),
    ).toBe("2026-07-31T08:00:00.000Z");
  });

  it("parses the live undated weekly-limit string to the next occurrence of the clock time, not the true weekly reset", () => {
    // The live wording sometimes drops the date ("resets 8am (UTC)" with no
    // "Jul 31,"), which is indistinguishable from a same-day clock hint. Master
    // falls through to nextClockTimeInTimeZone and returns the *next* 8am UTC —
    // for a weekly limit this can under-wait by up to ~7 days. That is an
    // accepted, converging behavior (the park re-arms on the next limit hit),
    // not a bug, so this test pins it as a deliberate, documented decision.
    const now = new Date("2026-07-25T10:00:00.000Z");
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "You've hit your weekly limit · resets 8am (UTC)" },
        now,
      )?.toISOString(),
    ).toBe("2026-07-26T08:00:00.000Z");
  });

  it("parses the live session-limit string to the exact absolute instant", () => {
    const now = new Date("2026-07-31T10:00:00.000Z");
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "You've hit your session limit · resets 6:50pm (UTC)" },
        now,
      )?.toISOString(),
    ).toBe("2026-07-31T18:50:00.000Z");
  });
});

describe("isClaudePreTurnRateLimitResult", () => {
  it("classifies a session-limit 429 that never reached the model", () => {
    expect(isClaudePreTurnRateLimitResult(SESSION_LIMIT_RESULT)).toBe(true);
  });

  it("does not classify a 429 that billed model turns", () => {
    expect(
      isClaudePreTurnRateLimitResult({
        ...SESSION_LIMIT_RESULT,
        duration_api_ms: 4_210,
        total_cost_usd: 0.12,
      }),
    ).toBe(false);
  });

  it("does not classify non-429 failures", () => {
    expect(
      isClaudePreTurnRateLimitResult({ ...SESSION_LIMIT_RESULT, api_error_status: 500 }),
    ).toBe(false);
    expect(isClaudePreTurnRateLimitResult({ ...SESSION_LIMIT_RESULT, api_error_status: undefined }))
      .toBe(false);
    expect(isClaudePreTurnRateLimitResult(null)).toBe(false);
  });
});
