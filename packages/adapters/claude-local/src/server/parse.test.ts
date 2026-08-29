import { describe, expect, it } from "vitest";
import {
  claudeModelUsageTotals,
  parseClaudeStreamJson,
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeProviderQuotaError,
  isClaudeTransientUpstreamError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeRefusalResult,
  isClaudeUnknownSessionError,
  isClaudeImageProcessingError,
  isClaudePreTurnRateLimitResult,
  isClaudeModelNotFoundError,
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

  it("classifies an invalid or expired OAuth bearer token as login required", () => {
    // Grounded on the real Claude CLI output for CLAUDE_CODE_OAUTH_TOKEN=invalid:
    // the result event carries a 401 authentication failure and an "Invalid
    // bearer token" message. This is an auth failure, not a probe that could not
    // run, so the detector must classify it as login required.
    const parsed = {
      is_error: true,
      subtype: "success",
      api_error_status: 401,
      error: "authentication_failed",
      result: "Failed to authenticate. API Error: 401 Invalid bearer token",
    };
    expect(
      detectClaudeLoginRequired({
        parsed,
        stdout:
          '{"type":"assistant","message":{"content":[{"type":"text","text":"Failed to authenticate. API Error: 401 Invalid bearer token"}]},"error":"authentication_failed"}',
        stderr: "",
      }).requiresLogin,
    ).toBe(true);
  });

  it("does not route an invalid token to the transient or quota classifiers", () => {
    // An auth failure must win over the transient and quota lanes, so a run
    // surfaces login required instead of a retry.
    const input = {
      parsed: {
        is_error: true,
        result: "Failed to authenticate. API Error: 401 Invalid bearer token",
      },
      stdout: "",
      stderr: "",
    };
    expect(isClaudeTransientUpstreamError(input)).toBe(false);
    expect(isClaudeProviderQuotaError(input)).toBe(false);
  });

  it("classifies an expired or revoked token in the parsed result as login required", () => {
    // The result event marks the run as a failure and reports an expired token.
    // This is a token failure, so the detector classifies it as login required.
    const parsed = {
      is_error: true,
      subtype: "success",
      result: "Failed to authenticate. Your OAuth access token is expired.",
    };
    expect(
      detectClaudeLoginRequired({ parsed, stdout: "", stderr: "" }).requiresLogin,
    ).toBe(true);
  });

  it("does not classify a successful probe whose assistant text repeats a token phrase", () => {
    // A healthy run can print an auth phrase in its answer text. The parsed
    // result is a success, so the token-failure markers must not fire on the raw
    // stdout assistant event.
    const parsed = {
      is_error: false,
      subtype: "success",
      result: "hello",
    };
    expect(
      detectClaudeLoginRequired({
        parsed,
        stdout:
          '{"type":"assistant","message":{"content":[{"type":"text","text":"The phrase authentication_failed means an invalid bearer token."}]}}',
        stderr: "",
      }).requiresLogin,
    ).toBe(false);
  });

  // When a clean result envelope is present, the detector must NOT scan raw
  // stdout/stderr. The transcript body of a real agent run can contain
  // auth-regex-matching text (security-review logs, tool output referencing
  // /login, etc.) without the run itself requiring login. Scanning raw stdout
  // on top of the envelope false-positives `requiresLogin`, which flips a
  // clean success to `claude_auth_required`.
  it("does not scan raw stdout/stderr when a clean result envelope is present", () => {
    const transcriptContainingAuthText = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-success",
        model: "claude-sonnet-4-6",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Inspecting the auth flow: the response was unauthorized, so the user must run `claude login` to refresh the token.",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-success",
        result: "Shipped the prevention gate for the auth-detector fix.",
        usage: { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 4 },
      }),
    ].join("\n");

    expect(
      detectClaudeLoginRequired({
        parsed: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Shipped the prevention gate for the auth-detector fix.",
        },
        stdout: transcriptContainingAuthText,
        stderr: "",
      }).requiresLogin,
    ).toBe(false);
  });

  it("does not classify a success whose result text repeats a token phrase", () => {
    // The model's own answer repeats a token phrase, so the phrase lands in the
    // parsed result. The run is a success, so the failure gate keeps it healthy.
    const parsed = {
      is_error: false,
      subtype: "success",
      result: "Sure. An invalid bearer token means authentication_failed.",
    };
    expect(
      detectClaudeLoginRequired({ parsed, stdout: "", stderr: "" }).requiresLogin,
    ).toBe(false);
  });

  it("keeps a transient failure with an assistant token phrase on the transient lane", () => {
    // The run fails on a 503 transient error. The token phrase appears only in
    // the raw stdout assistant event, not the parsed result, so the run stays
    // transient and never classifies as login required.
    const input = {
      parsed: {
        is_error: true,
        subtype: "error_during_execution",
        result: "API Error: 503 service unavailable",
      },
      stdout:
        '{"type":"assistant","message":{"content":[{"type":"text","text":"authentication_failed: the bearer token is invalid"}]}}',
      stderr: "",
    };
    expect(detectClaudeLoginRequired(input).requiresLogin).toBe(false);
    expect(isClaudeTransientUpstreamError(input)).toBe(true);
  });

  it("does not treat a bare token phrase in raw stdout with no parsed result as login required", () => {
    // Untrusted stdout alone must not satisfy a token-failure marker. Only the
    // parsed terminal result fields of a failed run can trip the token markers.
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "authentication_failed while the assistant called a tool",
        stderr: "",
      }).requiresLogin,
    ).toBe(false);
  });
  // Genuine auth failure path (AC 4): auth text in `parsed.result` or the CLI
  // error fields still yields `requiresLogin: true` because the structured
  // candidates are scanned.
  it("still classifies auth-required when the structured result field carries the login prompt", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "You are not logged in. Please run `claude login` to continue.",
        },
        stdout: "",
        stderr: "",
      }).requiresLogin,
    ).toBe(true);
  });

  it("still classifies auth-required when the structured errors[] carries the login prompt", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "",
          errors: [{ type: "authentication", message: "invalid API key — please run /login" }],
        },
        stdout: "",
        stderr: "",
      }).requiresLogin,
    ).toBe(true);
  });

  // The `!parsed` branch must keep raw-text scanning — it is the only signal
  // available when the CLI failed before emitting a structured result.
  it("falls back to raw stdout/stderr scanning when no parsed envelope is present", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: " debris from a teardown trace ",
        stderr: "Please run claude login",
      }).requiresLogin,
    ).toBe(true);
  });
});

describe("isClaudeModelNotFoundError", () => {
  it("detects model resolution failures from structured and fallback output", () => {
    expect(isClaudeModelNotFoundError({
      parsed: {
        result: "API Error: 404 model not found: claude-haiku-4-6",
      },
    })).toBe(true);
    expect(isClaudeModelNotFoundError({
      stderr: "Unknown model claude-haiku-4-6",
    })).toBe(true);
  });

  it("does not classify unrelated provider failures as model resolution errors", () => {
    expect(isClaudeModelNotFoundError({
      errorMessage: "API Error: 503 service unavailable",
    })).toBe(false);
  });
});

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as provider quota", () => {
    expect(
      isClaudeProviderQuotaError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeProviderQuotaError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(false);
  });

  it("classifies Claude session-limit windows as provider quota and extracts the retry time", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const errorMessage = "You've hit your session limit - resets at 4pm (America/Chicago).";

    expect(isClaudeProviderQuotaError({ errorMessage })).toBe(true);
    expect(isClaudeTransientUpstreamError({ errorMessage })).toBe(false);
    expect(extractClaudeRetryNotBefore({ errorMessage }, now)?.toISOString()).toBe(
      "2026-04-22T21:00:00.000Z",
    );
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

  it("classifies the subscription 5-hour / weekly limit wording as provider quota", () => {
    expect(
      isClaudeProviderQuotaError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeProviderQuotaError({
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

  it("classifies the session-limit failure as provider quota (merged contract)", () => {
    // v2026.824.1's quota classifier wins over the fork's transient classifier
    // for subscription-limit wording; the reset horizon is still extracted for
    // the retry backoff either way.
    expect(isClaudeProviderQuotaError({ parsed: SESSION_LIMIT_RESULT })).toBe(true);
    expect(isClaudeTransientUpstreamError({ parsed: SESSION_LIMIT_RESULT })).toBe(false);
    const now = new Date("2026-07-26T12:30:00.000Z");
    expect(extractClaudeRetryNotBefore({ parsed: SESSION_LIMIT_RESULT }, now)?.toISOString()).toBe(
      "2026-07-26T13:50:00.000Z",
    );
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

  // Exact live strings observed in `heartbeat_runs.result_json.result`
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

  // Live gateway phrasing from the 2026-08-25/26 provider outage: a 429 whose
  // body names the limit family and states the reset as an absolute UTC
  // timestamp. The classic `hit your X limit · resets <clock>` phrasing never
  // appears, so the clock-time capture alone cannot see these.
  it("parses a 'Limit Exhausted' 429 with an absolute reset timestamp", () => {
    const now = new Date("2026-08-26T10:00:00.000Z");
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "HTTP 429: Weekly/Monthly Limit Exhausted, limit will reset at 2026-08-27 12:31:10" },
        now,
      )?.toISOString(),
    ).toBe("2026-08-27T12:31:10.000Z");
  });

  it("parses an absolute reset timestamp with T separator and Z suffix", () => {
    const now = new Date("2026-08-26T10:00:00.000Z");
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "rate limit will reset at 2026-08-27T12:31:10Z" },
        now,
      )?.toISOString(),
    ).toBe("2026-08-27T12:31:10.000Z");
  });

  it("still parses clock-format resets after 'Limit Exhausted' phrasing", () => {
    const now = new Date("2026-07-30T10:00:00.000Z");
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "Weekly/Monthly Limit Exhausted · resets Jul 31, 8am (UTC)" },
        now,
      )?.toISOString(),
    ).toBe("2026-07-31T08:00:00.000Z");
  });

  it("returns null for 'Limit Exhausted' with no parseable reset", () => {
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "Weekly/Monthly Limit Exhausted" },
        new Date("2026-08-26T10:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("rejects calendar-invalid absolute reset timestamps", () => {
    expect(
      extractClaudeRetryNotBefore(
        { errorMessage: "limit will reset at 2026-02-31 10:00:00" },
        new Date("2026-08-26T10:00:00.000Z"),
      ),
    ).toBeNull();
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

describe("claudeModelUsageTotals", () => {
  it("sums per-model usage across models and counts cache writes as input", () => {
    const totals = claudeModelUsageTotals({
      "claude-fable-5": {
        inputTokens: 100,
        outputTokens: 70_000,
        cacheReadInputTokens: 250_000,
        cacheCreationInputTokens: 4_000,
        costUSD: 1.2,
      },
      "claude-haiku-4-5": {
        inputTokens: 50,
        outputTokens: 7_000,
        cacheReadInputTokens: 10_000,
        cacheCreationInputTokens: 500,
        costUSD: 0.05,
      },
    });
    expect(totals).toEqual({
      inputTokens: 4_650,
      outputTokens: 77_000,
      cachedInputTokens: 260_000,
    });
  });

  it("returns null for missing or empty modelUsage", () => {
    expect(claudeModelUsageTotals(undefined)).toBeNull();
    expect(claudeModelUsageTotals({})).toBeNull();
  });
});

describe("parseClaudeStreamJson usage extraction", () => {
  const resultEvent = (extra: Record<string, unknown>) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      result: "done",
      total_cost_usd: 1.25,
      usage: { input_tokens: 10, output_tokens: 1_800, cache_read_input_tokens: 20 },
      ...extra,
    });

  it("prefers modelUsage totals over the main-loop usage block and marks them per-run", () => {
    const parsed = parseClaudeStreamJson(
      `${resultEvent({
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 90,
            outputTokens: 77_000,
            cacheReadInputTokens: 300_000,
            cacheCreationInputTokens: 2_000,
          },
        },
      })}\n`,
    );
    expect(parsed.usage).toEqual({
      inputTokens: 2_090,
      outputTokens: 77_000,
      cachedInputTokens: 300_000,
    });
    expect(parsed.usageBasis).toBe("per_run");
    expect(parsed.costUsd).toBeCloseTo(1.25);
  });

  it("falls back to the result usage block when modelUsage is absent", () => {
    const parsed = parseClaudeStreamJson(`${resultEvent({})}\n`);
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      outputTokens: 1_800,
      cachedInputTokens: 20,
    });
    expect(parsed.usageBasis).toBe("per_run");
  });
});
