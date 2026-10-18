import { describe, expect, it } from "vitest";

import { buildBuiltInAgentPausedToast } from "./built-in-agent-toast";

describe("buildBuiltInAgentPausedToast", () => {
  it("builds a warn toast with the default 'item' noun when featureNoun is omitted", () => {
    const toast = buildBuiltInAgentPausedToast({
      displayName: "Briefs Agent",
      agentHref: "/agents/briefs-agent",
    });

    expect(toast).toEqual({
      dedupeKey: "built-in-agent-paused:Briefs Agent",
      title: "Briefs Agent is paused",
      body: "Resume the agent to generate this item.",
      tone: "warn",
      action: { label: "View agent", href: "/agents/briefs-agent" },
    });
  });

  it("uses the provided featureNoun in the body copy", () => {
    const toast = buildBuiltInAgentPausedToast({
      displayName: "Briefs Agent",
      agentHref: "/agents/briefs-agent",
      featureNoun: "brief",
    });

    expect(toast.body).toBe("Resume the agent to generate this brief.");
  });

  it("derives the dedupeKey and title from the displayName", () => {
    const toast = buildBuiltInAgentPausedToast({
      displayName: "Standup Agent",
      agentHref: "/agents/standup-agent",
      featureNoun: "standup",
    });

    expect(toast.dedupeKey).toBe("built-in-agent-paused:Standup Agent");
    expect(toast.title).toBe("Standup Agent is paused");
  });

  it("always sets tone to warn and carries exactly one action link", () => {
    const toast = buildBuiltInAgentPausedToast({
      displayName: "Recap Agent",
      agentHref: "/agents/recap-agent",
      featureNoun: "recap",
    });

    expect(toast.tone).toBe("warn");
    expect(toast.action).toEqual({ label: "View agent", href: "/agents/recap-agent" });
  });

  it("passes the agentHref through verbatim, including query params", () => {
    const toast = buildBuiltInAgentPausedToast({
      displayName: "Digest Agent",
      agentHref: "/agents/digest-agent?tab=runs&from=toast",
      featureNoun: "digest",
    });

    expect(toast.action?.href).toBe("/agents/digest-agent?tab=runs&from=toast");
  });

  it("does not collapse an explicitly empty featureNoun to the 'item' default", () => {
    // `?? "item"` only falls back on null/undefined, not on an empty string,
    // so an empty featureNoun produces an intentionally odd body string.
    const toast = buildBuiltInAgentPausedToast({
      displayName: "Empty Agent",
      agentHref: "/agents/empty-agent",
      featureNoun: "",
    });

    expect(toast.body).toBe("Resume the agent to generate this .");
  });

  it("keeps a displayName containing a colon intact in the dedupeKey", () => {
    const toast = buildBuiltInAgentPausedToast({
      displayName: "Team: Ops Agent",
      agentHref: "/agents/ops-agent",
    });

    expect(toast.dedupeKey).toBe("built-in-agent-paused:Team: Ops Agent");
  });
});
