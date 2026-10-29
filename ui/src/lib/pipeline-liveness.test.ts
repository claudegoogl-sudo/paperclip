import type { PipelineCaseLiveness } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { derivePipelineLivenessBanner, shouldDisableRerunForPermission } from "./pipeline-liveness";

function liveness(overrides: Partial<PipelineCaseLiveness>): PipelineCaseLiveness {
  return {
    state: "blocked",
    reason: "case_blocked",
    message: "Default message.",
    ...overrides,
  } as PipelineCaseLiveness;
}

describe("derivePipelineLivenessBanner", () => {
  it("returns null when liveness is missing", () => {
    expect(derivePipelineLivenessBanner(null)).toBeNull();
    expect(derivePipelineLivenessBanner(undefined)).toBeNull();
  });

  it.each([
    "terminal",
    "lease_active",
    "linked_issue_active",
    "linked_issue_waiting",
    "children_waiting",
    "review_waiting",
  ] as const)("returns null for %s (handled elsewhere)", (reason) => {
    expect(derivePipelineLivenessBanner(liveness({ reason }))).toBeNull();
  });

  it("builds a blocked banner with blocker/automation links for case_blocked", () => {
    const view = derivePipelineLivenessBanner(
      liveness({
        reason: "case_blocked",
        message: "Waiting on upstream case.",
        blocker: { issueId: "issue-blocker", title: "Blocker task" },
        issue: { id: "issue-automation", identifier: "PAP-1", title: "Automation task", status: "open" },
      }),
    );

    expect(view).toMatchObject({
      reason: "case_blocked",
      tone: "blocked",
      title: "Automation paused — waiting on a blocker",
      body: "Waiting on upstream case.",
      blockerLink: { issueId: "issue-blocker", title: "Blocker task" },
      automationLink: { issueId: "issue-automation", identifier: "PAP-1", title: "Automation task" },
      permissionKey: null,
      showRetry: false,
      retryKind: null,
    });
  });

  it("builds a blocked banner for linked_issue_blocked without a blocker link when none is given", () => {
    const view = derivePipelineLivenessBanner(
      liveness({ reason: "linked_issue_blocked", message: "Linked issue is blocked." }),
    );

    expect(view).toMatchObject({
      tone: "blocked",
      blockerLink: null,
      automationLink: null,
      showRetry: false,
    });
  });

  it("derives permission key from an automation fingerprint for permission_preflight_failed", () => {
    const view = derivePipelineLivenessBanner(
      liveness({
        reason: "permission_preflight_failed",
        message: "Missing access.",
        automation: { fingerprint: "stage:case-123:pipelines:write" },
      }),
    );

    expect(view).toMatchObject({
      tone: "permission",
      title: "Permission needed before this can run",
      permissionKey: "pipelines:write",
      showRetry: false,
      retryKind: null,
    });
  });

  it("falls back to the default permission key when the fingerprint is missing or malformed", () => {
    const noFingerprint = derivePipelineLivenessBanner(
      liveness({ reason: "permission_preflight_failed", message: "Missing access." }),
    );
    expect(noFingerprint?.permissionKey).toBe("pipelines:write");

    const shortFingerprint = derivePipelineLivenessBanner(
      liveness({
        reason: "permission_preflight_failed",
        message: "Missing access.",
        automation: { fingerprint: "onlyonesegment" },
      }),
    );
    expect(shortFingerprint?.permissionKey).toBe("pipelines:write");
  });

  it("marks automation_failed as attention tone with a retry CTA keyed to automation", () => {
    const view = derivePipelineLivenessBanner(
      liveness({
        reason: "automation_failed",
        message: "The run errored out.",
        automation: { automationId: "automation-1" },
      }),
    );

    expect(view).toMatchObject({
      tone: "attention",
      title: "Automation failed",
      showRetry: true,
      retryKind: "automation",
      helperNote: null,
    });
  });

  it("marks automation_failed as a retry tone when the message announces a restored permission", () => {
    const view = derivePipelineLivenessBanner(
      liveness({
        reason: "automation_failed",
        message: "The missing permission has been restored, retrying automatically.",
      }),
    );

    expect(view).toMatchObject({
      tone: "retry",
      title: "Blocker resolved — ready to retry",
      showRetry: true,
      retryKind: "stage",
    });
    expect(view?.helperNote).toMatch(/retries automatically/);
  });

  it("keys automation_failed retry to stage when no automationId is present", () => {
    const view = derivePipelineLivenessBanner(
      liveness({ reason: "automation_failed", message: "The run errored out." }),
    );
    expect(view?.retryKind).toBe("stage");
  });

  it("builds a breakdown_pending banner with a stage retry CTA", () => {
    const view = derivePipelineLivenessBanner(
      liveness({ reason: "breakdown_pending", message: "Waiting on evidence." }),
    );

    expect(view).toMatchObject({
      tone: "attention",
      title: "Waiting on breakdown evidence",
      showRetry: true,
      retryKind: "stage",
    });
  });

  it("builds a breakdown_incomplete banner and appends the missing piece count to the body", () => {
    const view = derivePipelineLivenessBanner(
      liveness({
        reason: "breakdown_incomplete",
        message: "Breakdown is missing pieces.",
        breakdown: { missingRequestKeys: ["a", "b"] },
      }),
    );

    expect(view?.tone).toBe("blocked");
    expect(view?.body).toBe("Breakdown is missing pieces. 2 expected pieces are still missing.");
  });

  it("uses singular wording when exactly one breakdown piece is missing", () => {
    const view = derivePipelineLivenessBanner(
      liveness({
        reason: "breakdown_incomplete",
        message: "Breakdown is missing pieces.",
        breakdown: { missingRequestKeys: ["a"] },
      }),
    );

    expect(view?.body).toBe("Breakdown is missing pieces. 1 expected piece is still missing.");
  });

  it("falls back to the raw message for breakdown_incomplete when nothing is missing", () => {
    const view = derivePipelineLivenessBanner(
      liveness({ reason: "breakdown_incomplete", message: "Breakdown is missing pieces." }),
    );

    expect(view?.body).toBe("Breakdown is missing pieces.");
  });

  it("builds the no_action_path 'stuck' banner with the translated prosumer-voice body", () => {
    const view = derivePipelineLivenessBanner(
      liveness({ reason: "no_action_path", message: "No lease, linked work, blocker, automation retry path." }),
    );

    expect(view).toMatchObject({
      tone: "attention",
      title: "This item is stuck",
      showRetry: true,
      retryKind: "stage",
    });
    expect(view?.body).not.toContain("lease");
    expect(view?.body).toMatch(/can't see anything to work on next/);
  });
});

describe("shouldDisableRerunForPermission", () => {
  it("returns false when liveness is missing", () => {
    expect(shouldDisableRerunForPermission(null)).toBe(false);
    expect(shouldDisableRerunForPermission(undefined)).toBe(false);
  });

  it("returns true only when the reason is permission_preflight_failed", () => {
    expect(
      shouldDisableRerunForPermission(liveness({ reason: "permission_preflight_failed", message: "x" })),
    ).toBe(true);
  });

  it.each([
    "terminal",
    "case_blocked",
    "automation_failed",
    "breakdown_pending",
    "breakdown_incomplete",
    "no_action_path",
  ] as const)("returns false for reason %s", (reason) => {
    expect(shouldDisableRerunForPermission(liveness({ reason, message: "x" }))).toBe(false);
  });
});
