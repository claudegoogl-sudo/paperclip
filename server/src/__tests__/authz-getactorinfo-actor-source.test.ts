import { describe, expect, it } from "vitest";
import { getActorInfo } from "../routes/authz";
import { HttpError } from "../errors.js";

// Regression: getActorInfo must never synthesize an actor's credential
// provenance from an omitted field. The route-level twin of the
// service-layer actor-source hardening: `source` unset or unknown on a
// board actor used to default to "local_implicit" — the unconditional
// allow_local_board actor inside authorization.decide — and anything
// non-"agent_jwt" on the agent branch coerced to "agent_key". Today's
// auth middleware always sets source explicitly, so these paths are
// latent; this suite pins the fail-closed contract so a future middleware
// that forgets `source` fails loudly (403) instead of escalating silently.

function boardReq(source?: string) {
  return { actor: { type: "user" as const, userId: "u1", source, runId: null } } as any;
}

function agentReq(source?: string) {
  return { actor: { type: "agent" as const, agentId: "a1", source, runId: null } } as any;
}

describe("getActorInfo actor-source synthesis is deny-by-default", () => {
  describe("board branch", () => {
    it("denies (403) when req.actor.source is unset", () => {
      expect(() => getActorInfo(boardReq())).toThrow(HttpError);
      expect(() => getActorInfo(boardReq())).toThrow(/Board actor source is required/);
      try {
        getActorInfo(boardReq());
        expect.unreachable("getActorInfo must throw on unset source");
      } catch (error) {
        expect((error as HttpError).status).toBe(403);
      }
    });

    it("denies (403) when req.actor.source is unknown", () => {
      expect(() => getActorInfo(boardReq("some_future_source"))).toThrow(/Board actor source is required/);
      expect(() => getActorInfo(boardReq("agent_key" as any))).toThrow(/Board actor source is required/);
    });

    it.each(["local_implicit", "session", "board_key", "cloud_tenant"] as const)(
      "preserves an explicitly validated %s source",
      (source) => {
        const info = getActorInfo(boardReq(source));
        expect(info).toMatchObject({ actorType: "user", actorId: "u1", actorSource: source });
      },
    );
  });

  describe("agent branch", () => {
    it("denies (403) when req.actor.source is unset", () => {
      expect(() => getActorInfo(agentReq())).toThrow(HttpError);
      expect(() => getActorInfo(agentReq())).toThrow(/Agent actor source is required/);
      try {
        getActorInfo(agentReq());
        expect.unreachable("getActorInfo must throw on unset source");
      } catch (error) {
        expect((error as HttpError).status).toBe(403);
      }
    });

    it("denies (403) when req.actor.source is unknown or board-typed", () => {
      expect(() => getActorInfo(agentReq("session" as any))).toThrow(/Agent actor source is required/);
      expect(() => getActorInfo(agentReq("some_future_source" as any))).toThrow(/Agent actor source is required/);
    });

    it.each(["agent_key", "agent_jwt"] as const)(
      "preserves an explicitly validated %s source",
      (source) => {
        const info = getActorInfo(agentReq(source));
        expect(info).toMatchObject({ actorType: "agent", actorId: "a1", actorSource: source });
      },
    );
  });

  it("still denies unauthenticated (type none) actors first", () => {
    expect(() => getActorInfo({ actor: { type: "none" } } as any)).toThrow(HttpError);
  });
});
