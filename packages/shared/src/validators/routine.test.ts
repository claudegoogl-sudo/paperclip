import { describe, expect, it } from "vitest";
import {
  createRoutineSchema,
  routineRevisionSnapshotV1Schema,
  routineVariableSchema,
  updateRoutineSchema,
} from "./routine.js";

const routineId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const triggerId = "33333333-3333-4333-8333-333333333333";
const baseRevisionId = "44444444-4444-4444-8444-444444444444";
const goalId = "66666666-6666-4666-8666-666666666666";
const parentIssueId = "77777777-7777-4777-8777-777777777777";
const assigneeAgentId = "88888888-8888-4888-8888-888888888888";
const projectId = "99999999-9999-4999-8999-999999999999";

const fullRoutinePayload = {
  projectId,
  goalId,
  parentIssueId,
  title: "Daily triage",
  description: "Sweep the inbox",
  assigneeAgentId,
  priority: "high" as const,
  status: "paused" as const,
  concurrencyPolicy: "skip_if_active" as const,
  catchUpPolicy: "enqueue_missed_with_cap" as const,
  variables: [{ name: "region", type: "select" as const, options: ["eu", "us"], defaultValue: "eu" }],
  env: { REGION: { type: "plain" as const, value: "eu" } },
};

describe("routine validators", () => {
  it("accepts versioned routine revision snapshots with safe trigger metadata", () => {
    const parsed = routineRevisionSnapshotV1Schema.parse({
      version: 1,
      routine: {
        id: routineId,
        companyId,
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "Daily triage",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      triggers: [{
        id: triggerId,
        kind: "webhook",
        label: "Inbound",
        enabled: true,
        cronExpression: null,
        timezone: null,
        publicId: "routine_webhook_123",
        signingMode: "bearer",
        replayWindowSec: 300,
      }],
    });

    expect(parsed.triggers[0]?.publicId).toBe("routine_webhook_123");
  });

  it("rejects secret-bearing trigger fields in routine revision snapshots", () => {
    expect(() => routineRevisionSnapshotV1Schema.parse({
      version: 1,
      routine: {
        id: routineId,
        companyId,
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "Daily triage",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      triggers: [{
        id: triggerId,
        kind: "webhook",
        label: "Inbound",
        enabled: true,
        cronExpression: null,
        timezone: null,
        publicId: "routine_webhook_123",
        signingMode: "bearer",
        replayWindowSec: 300,
        secretId: "55555555-5555-4555-8555-555555555555",
      }],
    })).toThrow();
  });

  it("rejects unknown keys on routine creation and names the offending key", () => {
    const result = createRoutineSchema.safeParse({
      title: "Daily triage",
      triggers: [{ kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC" }],
    });

    expect(result.success).toBe(false);
    const issue = result.error!.errors[0]!;
    expect(issue.code).toBe("unrecognized_keys");
    expect(issue.message).toBe("Unrecognized key(s) in object: 'triggers'");
  });

  // updateRoutineSchema is derived via .partial().extend(), neither of which is
  // documented to carry strictness — assert it independently of create.
  it("rejects unknown keys on routine updates and names the offending key", () => {
    const result = updateRoutineSchema.safeParse({
      title: "Daily triage",
      triggers: [{ kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC" }],
    });

    expect(result.success).toBe(false);
    const issue = result.error!.errors[0]!;
    expect(issue.code).toBe("unrecognized_keys");
    expect(issue.message).toBe("Unrecognized key(s) in object: 'triggers'");
  });

  it("still accepts every documented field on create and update", () => {
    expect(createRoutineSchema.parse(fullRoutinePayload)).toMatchObject({
      ...fullRoutinePayload,
      variables: [{ name: "region", type: "select", options: ["eu", "us"], defaultValue: "eu", required: true }],
    });

    expect(updateRoutineSchema.parse({ ...fullRoutinePayload, baseRevisionId })).toMatchObject({
      ...fullRoutinePayload,
      baseRevisionId,
    });
  });

  it("accepts optional base revision ids on routine updates", () => {
    expect(updateRoutineSchema.parse({
      title: "Daily triage",
      baseRevisionId,
    }).baseRevisionId).toBe(baseRevisionId);
  });

  it("accepts date variables with valid YYYY-MM-DD defaults", () => {
    expect(routineVariableSchema.parse({
      name: "startDate",
      type: "date",
      defaultValue: "2024-02-29",
    })).toMatchObject({
      name: "startDate",
      type: "date",
      defaultValue: "2024-02-29",
    });
  });

  it("rejects date variables with non-calendar or non-string defaults", () => {
    expect(() => routineVariableSchema.parse({
      name: "startDate",
      type: "date",
      defaultValue: "2024-02-30",
    })).toThrow(/YYYY-MM-DD/);

    expect(() => routineVariableSchema.parse({
      name: "startDate",
      type: "date",
      defaultValue: 20240229,
    })).toThrow(/YYYY-MM-DD/);
  });
});
