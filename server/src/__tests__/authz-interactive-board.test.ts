/**
 * `requireInteractiveBoard` / `assertInteractiveBoard` split the board
 * gate by credential SOURCE. A board API key (source: "board_key") lives in a
 * file every same-uid agent on the host can read, so `type === "board"` alone no
 * longer proves a human is present. Only an authenticated browser session
 * (source: "session") may pass the secret-egress routes.
 *
 * This suite pins the AC3 actor matrix as executable checks and the AC5
 * scope-creep guard: the plugin-install-style gates (`assertBoard`,
 * `assertInstanceAdmin`) must STILL accept a board_key actor, so the stricter
 * gate is confined to the three egress routes and nothing else regresses.
 */

import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  assertBoard,
  assertInstanceAdmin,
  assertInteractiveBoard,
  requireInteractiveBoard,
} from "../routes/authz.js";

function makeReq(actor: Express.Request["actor"]): Express.Request {
  return { method: "GET", actor } as Express.Request;
}

// One representative actor per `source` the middleware can produce.
const actorsBySource: Record<
  NonNullable<Express.Request["actor"]["source"]>,
  Express.Request["actor"]
> = {
  session: {
    type: "board",
    userId: "operator-user",
    source: "session",
    isInstanceAdmin: false,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
  },
  board_key: {
    type: "board",
    userId: "operator-user",
    source: "board_key",
    keyId: "key-1",
    isInstanceAdmin: true,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
  },
  local_implicit: {
    type: "board",
    userId: "local-board",
    source: "local_implicit",
    isInstanceAdmin: true,
  },
  cloud_tenant: {
    type: "board",
    userId: "tenant-user",
    source: "cloud_tenant",
    isInstanceAdmin: false,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
  },
  agent_key: {
    type: "agent",
    agentId: "agent-1",
    companyId: "company-1",
    keyId: "agent-key-1",
    source: "agent_key",
  },
  agent_jwt: {
    type: "agent",
    agentId: "agent-1",
    companyId: "company-1",
    runId: "11111111-1111-1111-1111-111111111111",
    source: "agent_jwt",
  },
  none: {
    type: "none",
    source: "none",
  },
} as Record<NonNullable<Express.Request["actor"]["source"]>, Express.Request["actor"]>;

describe("requireInteractiveBoard actor matrix (AC3)", () => {
  it("only a browser session passes", () => {
    expect(requireInteractiveBoard(makeReq(actorsBySource.session))).toBe(true);
  });

  it("a board actor with no source at all is denied (fail-closed)", () => {
    expect(requireInteractiveBoard(makeReq({ type: "board", userId: "x" }))).toBe(false);
  });

  it.each([
    "board_key",
    "local_implicit",
    "cloud_tenant",
    "agent_key",
    "agent_jwt",
    "none",
  ] as const)("source %s is denied (not session)", (source) => {
    expect(requireInteractiveBoard(makeReq(actorsBySource[source]))).toBe(false);
  });

  it("assertInteractiveBoard throws 403 for a board_key actor", () => {
    try {
      assertInteractiveBoard(makeReq(actorsBySource.board_key));
      throw new Error("expected assertInteractiveBoard to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(403);
    }
  });

  it("assertInteractiveBoard does not throw for a session actor", () => {
    expect(() => assertInteractiveBoard(makeReq(actorsBySource.session))).not.toThrow();
  });
});

describe("scope-creep guard: plugin-install-style gates unchanged (AC5)", () => {
  it("assertBoard still accepts a board_key actor", () => {
    expect(() => assertBoard(makeReq(actorsBySource.board_key))).not.toThrow();
  });

  it("assertInstanceAdmin (guards POST /plugins/install) still accepts a board_key instance-admin actor", () => {
    // The operator's on-host board key resolves with isInstanceAdmin: true, which
    // is exactly how `paperclipai plugin install` authenticates today. The new
    // egress gate must not touch this path.
    expect(() => assertInstanceAdmin(makeReq(actorsBySource.board_key))).not.toThrow();
  });
});
