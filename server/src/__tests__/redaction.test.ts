import { afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRP_V1_EVENT_TYPES,
  REDACTED_EVENT_VALUE,
  REDACTED_VAULT_VALUE,
  redactAgentAdapterConfig,
  redactEventPayload,
  redactSensitiveText,
  sanitizeRecord,
} from "../redaction.js";
import { clearRunSecretValues, registerRunSecretValue } from "../run-secret-registry.js";

describe("redaction", () => {
  it("keeps the discriminator allowlist in exact PRP v1 schema parity", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/paperclip-runner/protocol/schemas/event.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { properties: { eventType: { enum: string[] } } };
    expect([...PRP_V1_EVENT_TYPES]).toEqual(schema.properties.eventType.enum);
  });

  it("preserves every discriminator in the cross-language replay stream", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/paperclip-runner/protocol/fixtures/replay/duplicate-event.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { events: Array<Record<string, unknown>> };

    for (const event of fixture.events) {
      const sanitized = redactEventPayload({ prpEvent: event });
      const envelope = sanitized?.prpEvent as Record<string, unknown>;
      expect(envelope.eventType).toBe(event.eventType);
      expect(envelope.sourceEventId).toBe(event.sourceEventId);
      expect(envelope.payload).toEqual(event.payload);
    }
  });

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
          version: "aaa.bbb.ccc",
          projectionAllowlistKey: "aaa.bbb.ccc",
          token: "must-not-survive-reference-shape",
        },
        USER_API_KEY_REF: {
          type: "user_secret_ref",
          key: "OPENAI_API_KEY",
          password: "must-not-survive-user-reference-shape",
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
      USER_API_KEY_REF: {
        type: "user_secret_ref",
        key: "OPENAI_API_KEY",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const input = {
      session: jwt,
      opaque: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.opaque).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("preserves Paperclip protocol schema identifiers", () => {
    expect(
      sanitizeRecord({
        schema: "paperclip.question_set.v1",
        nested: {
          schema: "paperclip.question_response.v1",
          runtimeSchema: "paperclip.runtime_request.v2",
          arbitraryProviderValue: "paperclip.question_set.v1",
        },
      }),
    ).toEqual({
      schema: "paperclip.question_set.v1",
      nested: {
        schema: "paperclip.question_response.v1",
        runtimeSchema: "paperclip.runtime_request.v2",
        arbitraryProviderValue: REDACTED_EVENT_VALUE,
      },
    });
  });

  it("preserves only known PRP v1 event discriminators inside validated envelopes", () => {
    const payload = {
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        eventType: "tool.execution.started",
        payload: {
          eventType: "run.result.accepted",
          credential: "aaa.bbb.ccc",
        },
      },
      unrelated: {
        eventType: "workspace.file.referenced",
      },
    };

    const sanitized = redactEventPayload(payload);

    expect(sanitized).toEqual({
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        eventType: "tool.execution.started",
        payload: {
          eventType: REDACTED_EVENT_VALUE,
          credential: REDACTED_EVENT_VALUE,
        },
      },
      unrelated: {
        eventType: REDACTED_EVENT_VALUE,
      },
    });
    expect(redactEventPayload(sanitized)).toEqual(sanitized);
  });

  it("redacts unknown dotted event values even in a PRP-shaped envelope", () => {
    expect(
      redactEventPayload({
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        eventType: "attacker.supplied.token",
      })?.eventType,
    ).toBe(REDACTED_EVENT_VALUE);
  });

  it("does not trust discriminators inside a forged unknown schema", () => {
    expect(
      redactEventPayload({
        schema: "paperclip.attacker.control.v1",
        runtimeSchema: "paperclip.attacker.runtime.v1",
        schemaVersion: 1,
        eventType: "tool.execution.started",
      }),
    ).toEqual({
      schema: REDACTED_EVENT_VALUE,
      runtimeSchema: REDACTED_EVENT_VALUE,
      schemaVersion: 1,
      eventType: REDACTED_EVENT_VALUE,
    });
  });

  it("preserves native run span identities without weakening hostname redaction", () => {
    const spanNames = [
      "environment.workspace.realize",
      "native.coordinator.claim",
      "runner.transport.selected",
      "runner.prp.authenticate",
      "runner.prp.route.register",
      "runner.transport.connect",
      "runner.session.bootstrap",
      "runner.turn.submit",
      "runner.session.startup",
      "provider.turn.queue",
      "question_response.to_run_created",
      "native.session.execute",
      "native.result.finalize",
      "task.run.measured",
    ];

    for (const span of spanNames) {
      const input = {
        schema: "paperclip.run-performance-span.v1",
        span,
        parentSpan: "native.session.execute",
        providerHostname: "api.openai.com",
      };
      const sanitized = redactEventPayload(input);

      expect(sanitized).toMatchObject({
        schema: input.schema,
        span,
        parentSpan: "native.session.execute",
        providerHostname: REDACTED_EVENT_VALUE,
      });
      expect(redactEventPayload(sanitized)).toEqual(sanitized);
    }

    expect(
      redactEventPayload({
        schema: "paperclip.run-performance-span.v1",
        span: "api.openai.com",
      })?.span,
    ).toBe(REDACTED_EVENT_VALUE);
    expect(
      redactEventPayload({
        schema: "paperclip.run-performance-span.v1",
        span: "runner.example.com",
      })?.span,
    ).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts credentials in ordinary nested diagnostic strings", () => {
    const sanitized = redactEventPayload({
      message: "request failed with Authorization: Basic dXNlcjpwYXNz",
      diagnostic: {
        reason: "upstream returned Bearer live-provider-token",
        details: [
          "safe context",
          "proxyAuthorization Basic nested-proxy-secret",
          "aaa.bbb.ccc",
          ["Bearer nested-array-secret"],
        ],
      },
    });

    expect(sanitized).toEqual({
      message: `request failed with Authorization: ${REDACTED_EVENT_VALUE}`,
      diagnostic: {
        reason: `upstream returned Bearer ${REDACTED_EVENT_VALUE}`,
        details: [
          "safe context",
          `proxyAuthorization ${REDACTED_EVENT_VALUE}`,
          REDACTED_EVENT_VALUE,
          [`Bearer ${REDACTED_EVENT_VALUE}`],
        ],
      },
    });
    expect(redactEventPayload(sanitized)).toEqual(sanitized);
  });

  it("preserves authorization decision reasons in audit payloads", () => {
    expect(
      redactEventPayload({
        authorizationReason: "allow_scoped_agent_write",
        authorization: "Bearer secret",
        surface: "issue.comment.create",
      }),
    ).toEqual({
      authorizationReason: "allow_scoped_agent_write",
      authorization: REDACTED_EVENT_VALUE,
      surface: "issue.comment.create",
    });
  });

  /**
   * A removal receipt (PAP-17119) has to show what it revoked, so a fixed set of
   * count keys is exempt from the secret-key guard — but only while the value is
   * a number. The second half of this test is the point: the same key carrying
   * anything else is still blanked, so the exemption cannot be used to smuggle
   * material out under a familiar name.
   */
  it("keeps numeric removal-receipt counts but still redacts non-numeric values on the same keys", () => {
    expect(
      sanitizeRecord({
        secretsRevoked: 2,
        secretsRetainedShared: 0,
        credentialRefsCleared: 3,
        secretBindingsRemoved: 3,
        tokenIssuanceHashesCleared: 1,
        gatewayTokensRevoked: 0,
        appProfile: "deleted",
      }),
    ).toEqual({
      secretsRevoked: 2,
      secretsRetainedShared: 0,
      credentialRefsCleared: 3,
      secretBindingsRemoved: 3,
      tokenIssuanceHashesCleared: 1,
      gatewayTokensRevoked: 0,
      appProfile: "deleted",
    });

    expect(
      sanitizeRecord({
        secretsRevoked: "pasted-api-key-value",
        secretBindingsRemoved: { name: "tool_app.abc.headers_authorization" },
        tokenIssuanceHashesCleared: Number.NaN,
        gatewayTokensRevoked: ["pcgw_live_token"],
      }),
    ).toEqual({
      secretsRevoked: REDACTED_EVENT_VALUE,
      secretBindingsRemoved: REDACTED_EVENT_VALUE,
      tokenIssuanceHashesCleared: REDACTED_EVENT_VALUE,
      gatewayTokensRevoked: REDACTED_EVENT_VALUE,
    });
  });

  it("redacts common secret shapes from unstructured text", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
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

  it("redacts authorization variants and standalone bearer credentials from diagnostic text", () => {
    const input = [
      "Authorization: Basic dXNlcjpwYXNz",
      "Authorization Basic uncolonized-secret",
      "proxyAuthorization Basic compound-secret",
      'Authorization Bearer abc"embedded-tail',
      'Authorization "Bearer quoted-secret"',
      'request failed with Bearer standalone"embedded-tail',
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(`Authorization: ${REDACTED_EVENT_VALUE}`);
    expect(result).toContain(`Authorization ${REDACTED_EVENT_VALUE}`);
    expect(result).toContain(`proxyAuthorization ${REDACTED_EVENT_VALUE}`);
    expect(result).toContain(`Authorization "${REDACTED_EVENT_VALUE}"`);
    expect(result).toContain(`Bearer ${REDACTED_EVENT_VALUE}`);
    expect(result).not.toContain("dXNlcjpwYXNz");
    expect(result).not.toContain("uncolonized-secret");
    expect(result).not.toContain("compound-secret");
    expect(result).not.toContain("embedded-tail");
    expect(result).not.toContain("quoted-secret");
    expect(result).not.toContain("standalone-secret");
    expect(redactSensitiveText(result)).toBe(result);
  });

  it("redacts a lone fine-grained github_pat_ with no other secret hint", () => {
    // Synthetic, shape-valid probe — never a real credential.
    const finePat = `github_pat_11${"B".repeat(80)}`;
    const result = redactSensitiveText(`rejected input ${finePat} at gate`);

    expect(result).not.toContain(finePat);
    expect(result).toContain(REDACTED_EVENT_VALUE);
  });

  });

  it("redacts inline secrets from command metadata without hiding safe command text", () => {
    const input = {
      command:
        "custom-acp --token ghp_example_secret env OPENAI_API_KEY=sk-live-example custom-acp",
      commandArgs: [
        "--safe",
        "ok",
        "--token",
        "ghp_arg_secret",
        "--api-key=sk-inline-example",
      ],
      env: {
        PAPERCLIP_RESOLVED_COMMAND:
          "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
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
      PAPERCLIP_RESOLVED_COMMAND: `env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp --token ${REDACTED_EVENT_VALUE}`,
      SAFE_VALUE: "visible",
    });
  });

  it("redacts non-string command args after secret flags", () => {
    const result = redactEventPayload({
      commandArgs: ["--api-key", { nested: "secret-value" }, "safe-next"],
    });

    expect(result?.commandArgs).toEqual([
      "--api-key",
      REDACTED_EVENT_VALUE,
      "safe-next",
    ]);
  });

  it("does not treat bare args payloads as command args", () => {
    const result = redactEventPayload({
      args: ["--api-key", "not-a-command-secret"],
      argv: ["--api-key", "command-secret"],
    });

    expect(result?.args).toEqual(["--api-key", "not-a-command-secret"]);
    expect(result?.argv).toEqual(["--api-key", REDACTED_EVENT_VALUE]);
  });

  it("redacts every plaintext agent env binding while preserving secret references", () => {
    const plaintextValue = "adapter-env-value-must-not-leak";

    const result = redactAgentAdapterConfig({
      command: "pnpm agent:run",
      env: {
        EXISTING_VALUE: plaintextValue,
        NEW_VALUE: { type: "plain", value: plaintextValue },
        SECRET_REFERENCE: {
          type: "secret_ref",
          secretId: "55555555-5555-4555-8555-555555555555",
          version: "latest",
        },
        USER_SECRET_REFERENCE: {
          type: "user_secret_ref",
          key: "GITHUB_TOKEN",
        },
      },
    });

    expect(result).toEqual({
      command: "pnpm agent:run",
      env: {
        EXISTING_VALUE: { type: "plain", value: REDACTED_EVENT_VALUE },
        NEW_VALUE: { type: "plain", value: REDACTED_EVENT_VALUE },
        SECRET_REFERENCE: {
          type: "secret_ref",
          secretId: "55555555-5555-4555-8555-555555555555",
          version: "latest",
        },
        USER_SECRET_REFERENCE: {
          type: "user_secret_ref",
          key: "GITHUB_TOKEN",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(plaintextValue);
  });

  it("redacts non-env adapter keys while leaving env binding shapes intact", () => {
    const result = redactAgentAdapterConfig({
      command: "pnpm agent:run",
      apiKey: "adapter-level-secret",
      env: {
        API_KEY: "env-level-secret",
        AUTH_TOKEN: { type: "plain", value: "another-env-secret" },
      },
    });

    // Non-env keys still go through the shared payload sanitizer.
    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.command).toBe("pnpm agent:run");

    // Env bindings keep their binding shape rather than collapsing to a bare
    // sentinel string, which is what a second sanitizer pass would produce for
    // these sensitive-looking key names.
    expect(result.env).toEqual({
      API_KEY: { type: "plain", value: REDACTED_EVENT_VALUE },
      AUTH_TOKEN: { type: "plain", value: REDACTED_EVENT_VALUE },
    });
  });

  it("redacts adapter configs that have no env block", () => {
    expect(redactAgentAdapterConfig({ command: "pnpm agent:run", apiKey: "secret" })).toEqual({
      command: "pnpm agent:run",
      apiKey: REDACTED_EVENT_VALUE,
    });
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

  it("redacts a registered secret used as a JSON object key (text-pipeline parity)", () => {
    // The pre-structural text pipeline scrubbed secret bytes at ANY position
    // in the serialized line — key positions included. Structural redaction
    // applies the leaf redactor to keys so a secret cannot survive there.
    registerRunSecretValue(RUN_ID, KEY);
    const line = JSON.stringify({ [KEY]: "x", other: "y" });
    const redactedLine = redactSensitiveText(line);

    expect(redactedLine).not.toContain(KEY);
    expect(() => JSON.parse(redactedLine)).not.toThrow();
  });

  it("redacts shape-based secrets (sk- / ghp_ / github_pat_) used as JSON keys", () => {
    const line = JSON.stringify({
      "sk-projabcdefghijklmnopqrstuv": "x",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345": 1,
      "github_pat_11AAAA0123456789012345678901234567890123456": 2,
    });
    const redactedLine = redactSensitiveText(line);

    expect(redactedLine).not.toContain("sk-projabcdefghijklmnopqrstuv");
    expect(redactedLine).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(redactedLine).not.toContain("github_pat_11AAAA");
    expect(() => JSON.parse(redactedLine)).not.toThrow();
  });

  it("JSON line keeps its trailing newline through redaction", () => {
    // Run-log consumers persist one JSON event per NDJSON line and join
    // records on the newline boundary. If redaction drops the trailing "\n",
    // adjacent lines merge into one unparseable blob.
    registerRunSecretValue(RUN_ID, KEY);
    const event = { type: "message_end", message: `token ${KEY} used` };
    const lineWithNewline = `${JSON.stringify(event)}\n`;

    const redacted = redactSensitiveText(lineWithNewline);

    expect(redacted.endsWith("\n")).toBe(true);
    // Positive control: the fix must not weaken scrubbing.
    expect(redacted).not.toContain(KEY);
    const parsed = JSON.parse(redacted.trimEnd()) as typeof event;
    expect(parsed.message).toBe(`token ${REDACTED_VAULT_VALUE} used`);

    // Leading whitespace (e.g. indentation from a pretty-printed transcript)
    // must be preserved too.
    const leadingWhitespace = `  ${JSON.stringify(event)}`;
    const redactedLeading = redactSensitiveText(leadingWhitespace);
    expect(redactedLeading.startsWith("  ")).toBe(true);
    expect(redactedLeading).not.toContain(KEY);
  });
});
