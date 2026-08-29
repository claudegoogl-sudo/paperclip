import { redactCommandText } from "@paperclipai/adapter-utils";
import { redactRegisteredSecretValues } from "./run-secret-registry.js";
import { GITHUB_FINE_GRAINED_PAT_RE } from "./secret-patterns.js";

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|browser[-_]?code|login[-_]?url)[A-Za-z0-9_-]*`;

const SECRET_PAYLOAD_KEY_RE = new RegExp(SECRET_FIELD_NAME_PATTERN, "i");
// Authorization reasons are policy decision codes, not credentials. They must
// remain visible in audit receipts even though the field name contains
// "authorization". JWT-shaped values are still caught by the value guard below.
const AUDIT_REASON_PAYLOAD_KEY_RE = /^authorizationReason$/;
const AUDIT_SURFACE_PAYLOAD_KEY_RE = /^surface$/;
const COMMAND_PAYLOAD_KEY_RE =
  /(^command$|^cmd$|command[-_]?line|resolved[-_]?command|PAPERCLIP_RESOLVED_COMMAND)/i;
const COMMAND_ARGS_PAYLOAD_KEY_RE = /^(commandArgs|command_?args|argv)$/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const CLI_SECRET_FLAG_RE = new RegExp(String.raw`^-{1,2}${SECRET_FIELD_NAME_PATTERN}$`, "i");
const JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:"|')?${SECRET_FIELD_NAME_PATTERN}(?:"|')?\s*:\s*(?:"|'))[^"'` + "`" + String.raw`\r\n]+((?:"|'))`,
  "gi",
);
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:\\")?${SECRET_FIELD_NAME_PATTERN}(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))`,
  "gi",
);
const SECRET_TEXT_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  // SECURITY-CRITICAL: Fine-grained PAT prefix. The classic `gh[pousr]_` covered above does not
  // subsume it, so without this hint a lone `github_pat_…` short-circuits the
  // gate below unredacted.
  "github_pat_",
] as const;
export const REDACTED_EVENT_VALUE = "***REDACTED***";

// Global copy of the shared fine-grained PAT matcher (secret-patterns.ts is the
// single source of truth). The shared patterns are authored without `g`; the
// free-form text path replaces every occurrence, so a global copy is needed
// here.
const GITHUB_FINE_GRAINED_PAT_TEXT_RE = new RegExp(GITHUB_FINE_GRAINED_PAT_RE.source, "g");
/**
 * Marker for value-exact redaction of a host-registered secret (e.g. a
 * `vault.read` plaintext). Distinct from {@link REDACTED_EVENT_VALUE} so a
 * value-exact hit is attributable in a persisted record.
 */
export const REDACTED_VAULT_VALUE = "***REDACTED:vault***";

function maybeContainsSecretText(input: string) {
  const lower = input.toLowerCase();
  return SECRET_TEXT_HINTS.some((hint) => lower.includes(hint)) || input.includes(".");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * SECURITY-CRITICAL: redactor applied to plain string leaves reached via
 * {@link sanitizeRecord}. The exported record path only value-exact scrubs
 * leaves (preserving its long-standing semantics); the structural path used by
 * {@link redactSensitiveText} applies the full free-form pipeline so serializing
 * a JSON document through redaction never weakens coverage.
 */
type LeafTextRedactor = (text: string) => string;

const valueExactLeafRedactor: LeafTextRedactor = (text) =>
  redactRegisteredSecretValues(text, REDACTED_VAULT_VALUE);

const freeFormLeafRedactor: LeafTextRedactor = (text) => redactSensitiveText(text);

function sanitizeValue(value: unknown, leaf: LeafTextRedactor): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, leaf));
  if (isSecretRefBinding(value)) return value;
  if (isUserSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value, leaf) };
  // String leaves (e.g. a tool result's `data.value`) get value-exact scrubbing
  // for any host-registered secret before being returned unchanged otherwise.
  if (typeof value === "string") return leaf(value);
  if (!isPlainObject(value)) return value;
  return sanitizeRecordWithLeaf(value, leaf);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isUserSecretRefBinding(value: unknown): value is { type: "user_secret_ref"; key: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "user_secret_ref" && typeof value.key === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

function sanitizeCommandArgs(args: unknown[], leaf: LeafTextRedactor): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_EVENT_VALUE;
    }
    if (typeof arg !== "string") return sanitizeValue(arg, leaf);
    if (CLI_SECRET_FLAG_RE.test(arg.trim())) {
      redactNext = true;
      return arg;
    }
    return redactSensitiveText(arg);
  });
}

function sanitizeRecordWithLeaf(
  record: Record<string, unknown>,
  leaf: LeafTextRedactor,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    // The pre-structural text pipeline scrubbed secret bytes anywhere in the
    // serialized line — key positions included. Apply the same leaf redactor
    // to keys so structural redaction cannot smuggle a secret through as a
    // key. Key-matching REs below still test the ORIGINAL key.
    const redactedKey = leaf(key) as string;
    if (COMMAND_ARGS_PAYLOAD_KEY_RE.test(key) && Array.isArray(value)) {
      redacted[redactedKey] = sanitizeCommandArgs(value, leaf);
      continue;
    }
    if (COMMAND_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[redactedKey] = redactSensitiveText(value);
      continue;
    }
    if (SECRET_PAYLOAD_KEY_RE.test(key) && !AUDIT_REASON_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[redactedKey] = sanitizeValue(value, leaf);
        continue;
      }
      if (isUserSecretRefBinding(value)) {
        redacted[redactedKey] = sanitizeValue(value, leaf);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[redactedKey] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[redactedKey] = REDACTED_EVENT_VALUE;
      continue;
    }
    if (typeof value === "string" && JWT_VALUE_RE.test(value) && !AUDIT_SURFACE_PAYLOAD_KEY_RE.test(key)) {
      redacted[redactedKey] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[redactedKey] = sanitizeValue(value, leaf);
  }
  return redacted;
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return sanitizeRecordWithLeaf(record, valueExactLeafRedactor);
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}

// ── Structural (serialized-JSON) redaction ─────────────────────────────────
//
// redactSensitiveText also runs over text that is itself a serialized JSON
// document (run-log chunks are JSON.stringify'd agent events). Running the
// free-form regexes over SERIALIZED JSON corrupts it: a secret adjacent to a
// JSON escape (e.g. `Bearer <secret>\"`) lets a quote-adjacent value class
// consume the backslash and re-emit a bare quote, so the persisted line no
// longer parses and dashboard transcripts render raw JSON blobs.
//
// JSON-parseable input is therefore redacted STRUCTURALLY — parse, redact the
// object graph, re-serialize — which preserves document integrity by
// construction. String leaves still get the SAME free-form pipeline, applied to
// their DECODED value (where quote-adjacent regexes behave correctly), so this
// path is coverage-equivalent-or-stronger than the text pipeline it replaces
// for JSON inputs.
//
// Re-entrancy budget: string leaves re-enter redactSensitiveText (a leaf may
// itself hold serialized JSON). A module-level counter bounds the total
// structural depth of one call tree so adversarially nested inputs cannot
// exhaust the stack; redaction is synchronous, so the counter cannot interleave.
// Past the budget the free-form pipeline applies unchanged.
const MAX_STRUCTURAL_REDACTION_DEPTH = 8;
let structuralRedactionDepth = 0;

function tryParseJson(input: string): unknown {
  // JSON.parse never returns undefined on success, so undefined reliably means
  // "not JSON" here.
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (isPlainObject(value)) return sanitizeRecordWithLeaf(value, freeFormLeafRedactor);
  if (typeof value === "string") return freeFormLeafRedactor(value);
  return value;
}

export function redactSensitiveText(input: string): string {
  if (structuralRedactionDepth < MAX_STRUCTURAL_REDACTION_DEPTH) {
    const parsed = tryParseJson(input);
    if (parsed !== undefined) {
      structuralRedactionDepth += 1;
      try {
        return JSON.stringify(sanitizeJsonValue(parsed));
      } catch {
        // SECURITY-CRITICAL: any structural-walk failure (e.g. a pathologically
        // nested document that JSON.parse accepts but overflows the recursive
        // walker's stack) falls back to the free-form pipeline. Redaction is
        // never skipped — only the mode changes.
        return redactFreeFormText(input);
      } finally {
        structuralRedactionDepth -= 1;
      }
    }
  }
  return redactFreeFormText(input);
}

function redactFreeFormText(input: string): string {
  // SECURITY-CRITICAL: Value-exact scrub runs FIRST and unconditionally: a high-entropy registered
  // secret may carry no secret-ish hint, so it would survive the
  // maybeContainsSecretText short-circuit below (Control 1).
  const valueScrubbed = redactRegisteredSecretValues(input, REDACTED_VAULT_VALUE);
  if (!maybeContainsSecretText(valueScrubbed)) return valueScrubbed;
  // The shared adapter-utils GitHub matcher is `\bgh[pousr]_…` and does not
  // cover the fine-grained `github_pat_` shape, so scrub it here with the
  // canonical secret-patterns matcher after the command-text pass.
  return redactCommandText(
    valueScrubbed
      .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`),
    REDACTED_EVENT_VALUE,
  ).replace(GITHUB_FINE_GRAINED_PAT_TEXT_RE, REDACTED_EVENT_VALUE);
}
