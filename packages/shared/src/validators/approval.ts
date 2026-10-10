import { z } from "zod";
import { APPROVAL_TYPES, type ApprovalType } from "../constants.js";
import { multilineTextSchema } from "./text.js";

/**
 * A board approval card has to be decidable on its own: the operator must be
 * able to see what is being asked (`title`) and why (`summary`) without
 * opening follow-up threads. Extra fields (risks, links, recommended action)
 * are preserved via passthrough.
 */
export const requestBoardApprovalPayloadSchema = z
  .object({
    title: z.string().trim().min(1),
    summary: multilineTextSchema.pipe(z.string().trim().min(1)),
  })
  .passthrough();

export type RequestBoardApprovalPayload = z.infer<typeof requestBoardApprovalPayloadSchema>;

/**
 * Per-type payload contracts. Approval types without an entry (hire_agent is
 * assembled server-side by the hire flow; budget_override_required is emitted
 * by budget enforcement; approve_ceo_strategy has no established payload
 * contract yet) accept any object, exactly as before.
 */
export const approvalPayloadSchemasByType: Partial<Record<ApprovalType, z.ZodType<unknown>>> = {
  request_board_approval: requestBoardApprovalPayloadSchema,
};

export const APPROVAL_PAYLOAD_EMPTY_CODE = "approval_payload_empty";
export const APPROVAL_PAYLOAD_EMPTY_MESSAGE =
  "Approval payload must not be empty. Include at least one field describing the request so the operator can decide the card.";

/**
 * Discriminated payload validation, shared by the server route (authoritative
 * 4xx boundary) and the MCP tool schema (early agent-facing feedback).
 */
export function refineApprovalPayload(
  value: { type: string; payload: unknown },
  ctx: z.RefinementCtx,
): void {
  if (isEmptyApprovalPayload(value.payload)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload"],
      message: APPROVAL_PAYLOAD_EMPTY_MESSAGE,
      params: { code: APPROVAL_PAYLOAD_EMPTY_CODE },
    });
    return;
  }
  const payloadSchema = approvalPayloadSchemasByType[value.type as ApprovalType];
  if (!payloadSchema) return;
  const result = payloadSchema.safeParse(value.payload);
  if (result.success) {
    // The payload record itself passes values through verbatim, so write the
    // schema output (trimmed title/summary) back onto the parsed body — the
    // stored card should carry the same text the validator accepted.
    Object.assign(value.payload as Record<string, unknown>, result.data);
    return;
  }
  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload", ...issue.path],
      message: issue.message,
    });
  }
}

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().guid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().guid()).optional(),
});

/**
 * A contentless approval payload (`{}`) is not a decidable request: the
 * operator cannot tell what is being asked, and a pending card cannot be
 * repaired by its author. `refineApprovalPayload` applies this predicate for
 * every approval type, so route and MCP tool share one check.
 */
export function isEmptyApprovalPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return true;
  }
  return Object.keys(payload as Record<string, unknown>).length === 0;
}

export type CreateApproval = z.infer<typeof createApprovalSchema>;

/**
 * Full creation request: shape plus the discriminated payload refinement.
 * Parsed by the server route (authoritative 4xx boundary) and by the MCP
 * create tool's execute path (early agent-facing feedback), so an undecidable
 * card — e.g. an empty request_board_approval payload — is rejected at
 * whichever boundary the caller reaches first.
 */
export const createApprovalRequestSchema = createApprovalSchema.superRefine(refineApprovalPayload);

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
