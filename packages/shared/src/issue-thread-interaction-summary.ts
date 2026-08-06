/**
 * Human-readable one-shot summary of an issue thread interaction payload.
 *
 * Notification relays (Telegram, email, any plugin that subscribes to
 * `issue.interaction.created`) have no read surface for the interaction payload
 * itself, so unless the question text travels with the event they can only
 * announce that *an* interaction exists. That turns an approval gate into a
 * silent stall: the human is pinged but has nothing to answer.
 *
 * This renders the parts a human needs to answer from the notification alone —
 * the prompt and the option labels — and truncates rather than drops, because a
 * clipped question is still actionable while an empty one is not.
 */

export const INTERACTION_SUMMARY_MAX_CHARS = 1000;
export const INTERACTION_SUMMARY_TRUNCATION_MARKER = "… [truncated]";

/** Cap on option/task lines rendered per interaction before eliding the rest. */
const MAX_LISTED_ITEMS = 10;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Truncate on a whitespace boundary when one is close to the limit, so the tail
 * of the visible text is a whole word rather than a severed one.
 */
export function truncateInteractionSummary(
  text: string,
  maxChars: number = INTERACTION_SUMMARY_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(1, maxChars - INTERACTION_SUMMARY_TRUNCATION_MARKER.length);
  const head = text.slice(0, budget);
  const lastBreak = head.search(/\s+\S*$/);
  const body = lastBreak > budget * 0.6 ? head.slice(0, lastBreak) : head;
  return `${body.trimEnd()}${INTERACTION_SUMMARY_TRUNCATION_MARKER}`;
}

function renderLabelledItems(items: unknown[], bullet = "-"): string[] {
  const lines: string[] = [];
  for (const item of items.slice(0, MAX_LISTED_ITEMS)) {
    const record = asRecord(item);
    const label = asNonEmptyString(record?.label) ?? asNonEmptyString(record?.title);
    if (label) lines.push(`${bullet} ${label}`);
  }
  const hidden = items.length - MAX_LISTED_ITEMS;
  if (hidden > 0) lines.push(`${bullet} …and ${hidden} more`);
  return lines;
}

function summarizeAskUserQuestions(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const title = asNonEmptyString(payload.title);
  if (title) lines.push(title);
  const questions = asArray(payload.questions);
  for (const question of questions.slice(0, MAX_LISTED_ITEMS)) {
    const record = asRecord(question);
    const prompt = asNonEmptyString(record?.prompt);
    if (!prompt) continue;
    lines.push(prompt);
    lines.push(...renderLabelledItems(asArray(record?.options)));
  }
  const hidden = questions.length - MAX_LISTED_ITEMS;
  if (hidden > 0) lines.push(`…and ${hidden} more question(s)`);
  return lines;
}

/**
 * Render `kind` + `payload` down to the text a human needs to answer.
 * Returns `null` when the payload carries no human-readable content, so callers
 * can distinguish "nothing to say" from "empty string".
 */
export function summarizeIssueThreadInteractionPayload(
  kind: string,
  payload: unknown,
  maxChars: number = INTERACTION_SUMMARY_MAX_CHARS,
): string | null {
  const record = asRecord(payload);
  if (!record) return null;

  const lines: string[] = [];
  switch (kind) {
    case "ask_user_questions":
      lines.push(...summarizeAskUserQuestions(record));
      break;
    case "suggest_tasks": {
      const tasks = asArray(record.tasks);
      if (tasks.length > 0) {
        lines.push(`Suggested task(s): ${tasks.length}`);
        lines.push(...renderLabelledItems(tasks));
      }
      break;
    }
    default: {
      // request_confirmation, request_checkbox_confirmation, and any future
      // prompt-shaped kind: the prompt plus whatever options are offered.
      const prompt = asNonEmptyString(record.prompt);
      if (prompt) lines.push(prompt);
      lines.push(...renderLabelledItems(asArray(record.options)));
      break;
    }
  }

  const text = lines.join("\n").trim();
  return text ? truncateInteractionSummary(text, maxChars) : null;
}
