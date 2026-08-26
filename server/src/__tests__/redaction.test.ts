import { afterEach, describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  REDACTED_VAULT_VALUE,
  redactEventPayload,
  redactSensitiveText,
  sanitizeRecord,
} from "../redaction.js";
import { clearRunSecretValues, registerRunSecretValue } from "../run-secret-registry.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts common secret shapes from unstructured text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      `payload {"apiKey":"json-secret-value"}`,
      `paperclip {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      `escaped {\\"apiKey\\":\\"escaped-json-secret\\"}`,
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `GITHUB_TOKEN=${githubToken}`,
      `session=${jwt}`,
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain("live-bearer-token-value");
    expect(result).not.toContain("json-secret-value");
    expect(result).not.toContain("paperclip-json-secret");
    expect(result).not.toContain("escaped-json-secret");
    expect(result).not.toContain("paperclip-shell-secret");
    expect(result).not.toContain(githubToken);
    expect(result).not.toContain(jwt);
  });

  it("redacts a lone fine-grained github_pat_ with no other secret hint", () => {
    // Synthetic, shape-valid probe — never a real credential.
    const finePat = `github_pat_11${"B".repeat(80)}`;
    const result = redactSensitiveText(`rejected input ${finePat} at gate`);

    expect(result).not.toContain(finePat);
    expect(result).toContain(REDACTED_EVENT_VALUE);
  });

  it("does not over-redact a benign github_pat_ mention below the length floor", () => {
    const benign = "see github_pat_docs for setup";
    expect(redactSensitiveText(benign)).toBe(benign);
  });

  it("redacts inline secrets from command metadata without hiding safe command text", () => {
    const input = {
      command: "custom-acp --token ghp_example_secret env OPENAI_API_KEY=sk-live-example custom-acp",
      commandArgs: ["--safe", "ok", "--token", "ghp_arg_secret", "--api-key=sk-inline-example"],
      env: {
        PAPERCLIP_RESOLVED_COMMAND: "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
        SAFE_VALUE: "visible",
      },
    };

    const result = redactEventPayload(input);

    expect(result?.command).toBe(
      `custom-acp --token ${REDACTED_EVENT_VALUE} env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp`,
    );
    expect(result?.commandArgs).toEqual([
      "--safe",
      "ok",
      "--token",
      REDACTED_EVENT_VALUE,
      `--api-key=${REDACTED_EVENT_VALUE}`,
    ]);
    expect(result?.env).toEqual({
      PAPERCLIP_RESOLVED_COMMAND:
        `env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp --token ${REDACTED_EVENT_VALUE}`,
      SAFE_VALUE: "visible",
    });
  });

  it("redacts non-string command args after secret flags", () => {
    const result = redactEventPayload({
      commandArgs: ["--api-key", { nested: "secret-value" }, "safe-next"],
    });

    expect(result?.commandArgs).toEqual(["--api-key", REDACTED_EVENT_VALUE, "safe-next"]);
  });

  it("does not treat bare args payloads as command args", () => {
    const result = redactEventPayload({
      args: ["--api-key", "not-a-command-secret"],
      argv: ["--api-key", "command-secret"],
    });

    expect(result?.args).toEqual(["--api-key", "not-a-command-secret"]);
    expect(result?.argv).toEqual(["--api-key", REDACTED_EVENT_VALUE]);
  });
});

// ── Serialized-JSON integrity regression ───────────────────────────────────
// redactSensitiveText also runs over text that IS a serialized JSON document
// (run-log chunks are JSON.stringify'd agent events). The free-form regexes
// used to corrupt such text: a secret adjacent to a JSON escape (e.g.
// `Bearer <secret>\"`) let a quote-adjacent value class swallow the backslash
// and re-emit a bare quote, so the persisted line no longer parsed. JSON input
// is now redacted structurally (parse → redact → re-serialize), which keeps the
// document valid by construction WITHOUT weakening coverage: every secret
// shape below must still be fully redacted in the serialized output.
describe("redactSensitiveText serialized-JSON integrity", () => {
  const KEY = "pcp_agent_DEADBEEFcafe0123456789abcdef";
  const RUN_ID = "run-redaction-json-integrity";

  afterEach(() => {
    clearRunSecretValues(RUN_ID);
  });

  it("keeps a tool_execution_end event parseable when a Bearer secret sits inside escaped quotes", () => {
    const event = {
      type: "tool_execution_end",
      toolName: "ipython",
      result: {
        content: [
          {
            type: "text",
            text: `+ curl -s -H "Authorization: Bearer ${KEY}" http://localhost:3100/api/x\n200`,
          },
        ],
      },
    };
    const line = JSON.stringify(event);
    expect(() => JSON.parse(line)).not.toThrow();

    const redactedLine = redactSensitiveText(line);
    const parsed = JSON.parse(redactedLine) as typeof event;

    expect(redactedLine).not.toContain(KEY);
    expect(parsed.type).toBe("tool_execution_end");
    expect(parsed.result.content[0]?.text).toBe(
      `+ curl -s -H "Authorization: Bearer ${REDACTED_EVENT_VALUE}" http://localhost:3100/api/x\n200`,
    );
  });

  it("keeps a message_end event parseable when a registered secret sits adjacent to an escape", () => {
    registerRunSecretValue(RUN_ID, KEY);
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: `resolved vault value "${KEY}" for the run`,
      },
    };
    const redactedLine = redactSensitiveText(JSON.stringify(event));
    const parsed = JSON.parse(redactedLine) as typeof event;

    expect(redactedLine).not.toContain(KEY);
    expect(parsed.message.content).toBe(`resolved vault value "${REDACTED_VAULT_VALUE}" for the run`);
  });

  it("keeps a plain top-level string field parseable and redacted", () => {
    const event = {
      type: "message_end",
      message: `curl -H "Authorization: Bearer ${KEY}" http://localhost:3100/api/x`,
    };
    const redactedLine = redactSensitiveText(JSON.stringify(event));
    const parsed = JSON.parse(redactedLine) as typeof event;

    expect(redactedLine).not.toContain(KEY);
    expect(parsed.message).toBe(`curl -H "Authorization: Bearer ${REDACTED_EVENT_VALUE}" http://localhost:3100/api/x`);
  });

  it("keeps CLI-option and env-assignment secret shapes parseable and redacted", () => {
    // These shapes flow through quote-adjacent regexes too
    // (COMMAND_CLI_SECRET_OPTION_RE / COMMAND_ENV_SECRET_ASSIGNMENT_RE).
    const event = {
      type: "tool_execution_end",
      text: `run --api-key=sk-cli-secret-12345 done`,
      env: `PAPERCLIP_API_KEY=sk-env-secret-67890 tail`,
    };
    const redactedLine = redactSensitiveText(JSON.stringify(event));
    const parsed = JSON.parse(redactedLine) as typeof event;

    expect(redactedLine).not.toContain("sk-cli-secret-12345");
    expect(redactedLine).not.toContain("sk-env-secret-67890");
    expect(parsed.text).toBe(`run --api-key=${REDACTED_EVENT_VALUE} done`);
    expect(parsed.env).toBe(`PAPERCLIP_API_KEY=${REDACTED_EVENT_VALUE} tail`);
  });

  it("round-trips a benign serialized event byte-identically", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolName: "ipython",
      durationMs: 1234,
      ok: true,
      result: { content: [{ type: "text", text: "all good\nno secrets here" }] },
    });
    expect(redactSensitiveText(line)).toBe(line);
  });

  it("still redacts secrets from a serialized event nested inside a string leaf", () => {
    const event = {
      type: "tool_execution_end",
      payload: JSON.stringify({ note: `Authorization: Bearer ${KEY} tail` }),
    };
    const redactedLine = redactSensitiveText(JSON.stringify(event));
    const parsed = JSON.parse(redactedLine) as typeof event;
    const inner = JSON.parse(parsed.payload) as { note: string };

    expect(redactedLine).not.toContain(KEY);
    expect(inner.note).toBe(`Authorization: Bearer ${REDACTED_EVENT_VALUE} tail`);
  });
});
