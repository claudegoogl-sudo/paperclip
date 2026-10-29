import { describe, expect, it } from "vitest";
import { getPipelineStageColumnTone, pipelineStageAutomationSettingsHref } from "./pipeline-stage-presentation";

describe("getPipelineStageColumnTone", () => {
  it("returns the violet tone for review and in_review stages", () => {
    const review = getPipelineStageColumnTone("review");
    expect(review.outer).toContain("violet");
    expect(review.header).toContain("violet");
    expect(review.meta).toContain("violet");
    expect(review.body).toContain("violet");
    expect(review.bodyOver).toContain("violet");

    const inReview = getPipelineStageColumnTone("in_review");
    expect(inReview).toEqual(review);
  });

  it("returns the green tone for the done stage", () => {
    const done = getPipelineStageColumnTone("done");
    expect(done.outer).toContain("green");
    expect(done.header).toContain("green");
    expect(done.meta).toContain("green");
    expect(done.body).toContain("green");
    expect(done.bodyOver).toContain("green");
  });

  it("returns the muted/neutral tone for the cancelled stage", () => {
    const cancelled = getPipelineStageColumnTone("cancelled");
    expect(cancelled.outer).toContain("neutral");
    expect(cancelled.outer).toContain("opacity-85");
    expect(cancelled.header).toContain("text-muted-foreground/80");
    expect(cancelled.body).toContain("bg-muted/20");
    expect(cancelled.bodyOver).toContain("bg-muted/45");
  });

  it("falls back to the default tone for an unrecognized stage kind", () => {
    const fallback = {
      outer: "border-border bg-background",
      header: "border-border text-muted-foreground",
      meta: "border-border",
      body: "",
      bodyOver: "bg-accent/40",
    };

    expect(getPipelineStageColumnTone("working")).toEqual(fallback);
    expect(getPipelineStageColumnTone("blocked")).toEqual(fallback);
    expect(getPipelineStageColumnTone("totally-unknown-stage")).toEqual(fallback);
  });

  it("falls back to the default tone for null, undefined, and empty/blank input", () => {
    const fallback = getPipelineStageColumnTone(undefined);

    expect(getPipelineStageColumnTone(null)).toEqual(fallback);
    expect(getPipelineStageColumnTone("")).toEqual(fallback);
    expect(getPipelineStageColumnTone("   ")).toEqual(fallback);
  });

  it("is case-insensitive and trims surrounding whitespace when matching a known stage", () => {
    const review = getPipelineStageColumnTone("review");

    expect(getPipelineStageColumnTone("REVIEW")).toEqual(review);
    expect(getPipelineStageColumnTone("Review")).toEqual(review);
    expect(getPipelineStageColumnTone("  review  ")).toEqual(review);
    expect(getPipelineStageColumnTone("  IN_REVIEW  ")).toEqual(getPipelineStageColumnTone("in_review"));
  });
});

describe("pipelineStageAutomationSettingsHref", () => {
  it("builds a settings href with the stage query param and instructions section", () => {
    expect(pipelineStageAutomationSettingsHref("pipeline-1", "stage-1")).toBe(
      "/pipelines/pipeline-1/settings?stage=stage-1&section=instructions",
    );
  });

  it("interpolates arbitrary pipeline and stage ids verbatim, without percent-encoding", () => {
    // Documents current behavior: the function does not call encodeURIComponent
    // on either id, so characters that are meaningful in a URL (?, &, #, /, space)
    // pass through untouched into the query string.
    expect(pipelineStageAutomationSettingsHref("pipe/with slash", "stage&weird=id")).toBe(
      "/pipelines/pipe/with slash/settings?stage=stage&weird=id&section=instructions",
    );
    expect(pipelineStageAutomationSettingsHref("pipeline-1", "stage#1")).toBe(
      "/pipelines/pipeline-1/settings?stage=stage#1&section=instructions",
    );
  });

  it("supports typical UUID-shaped ids", () => {
    expect(
      pipelineStageAutomationSettingsHref(
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ),
    ).toBe(
      "/pipelines/11111111-1111-1111-1111-111111111111/settings?stage=22222222-2222-2222-2222-222222222222&section=instructions",
    );
  });
});
