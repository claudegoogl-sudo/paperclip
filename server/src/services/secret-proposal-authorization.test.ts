import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

const mockDecide = vi.hoisted(() => vi.fn());
vi.mock("./access.js", () => ({ accessService: () => ({ decide: mockDecide }) }));

import { assertCanResolveProposal } from "./secret-proposal-authorization.js";

const baseInput = {
  db: {} as never,
  actor: { type: "board" } as never,
  companyId: "company-1",
};

describe("assertCanResolveProposal", () => {
  it("denies a 'secret' proposal when no assertSecretDefinitionAdmin check is supplied", async () => {
    await expect(
      assertCanResolveProposal({
        ...baseInput,
        proposal: { kind: "secret", targetId: null },
      }),
    ).rejects.toMatchObject({ status: 403, message: "Company admin access required" });
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it("resolves a 'secret' proposal by delegating to assertSecretDefinitionAdmin without calling accessService", async () => {
    const assertSecretDefinitionAdmin = vi.fn();
    await expect(
      assertCanResolveProposal({
        ...baseInput,
        proposal: { kind: "secret", targetId: null },
        assertSecretDefinitionAdmin,
      }),
    ).resolves.toBeUndefined();
    expect(assertSecretDefinitionAdmin).toHaveBeenCalledOnce();
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it("propagates the error assertSecretDefinitionAdmin throws for a 'secret' proposal", async () => {
    const assertSecretDefinitionAdmin = vi.fn(() => {
      throw new HttpError(403, "Not a secret definition admin");
    });
    await expect(
      assertCanResolveProposal({
        ...baseInput,
        proposal: { kind: "secret", targetId: null },
        assertSecretDefinitionAdmin,
      }),
    ).rejects.toMatchObject({ status: 403, message: "Not a secret definition admin" });
  });

  it("rejects an unrecognized proposal kind as unprocessable", async () => {
    await expect(
      assertCanResolveProposal({
        ...baseInput,
        proposal: { kind: "unknown_kind", targetId: "agent-1" },
      }),
    ).rejects.toMatchObject({ status: 422, message: "Binding proposal target is missing" });
  });

  it("rejects a 'binding' proposal with no targetId as unprocessable", async () => {
    await expect(
      assertCanResolveProposal({
        ...baseInput,
        proposal: { kind: "binding", targetId: null },
      }),
    ).rejects.toMatchObject({ status: 422, message: "Binding proposal target is missing" });
  });

  it("resolves a 'binding' proposal when the access decision allows it, passing the right decide() input", async () => {
    mockDecide.mockResolvedValueOnce({ allowed: true });
    await expect(
      assertCanResolveProposal({
        ...baseInput,
        proposal: { kind: "binding", targetId: "agent-1" },
      }),
    ).resolves.toBeUndefined();
    expect(mockDecide).toHaveBeenCalledWith({
      actor: baseInput.actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId: "company-1", agentId: "agent-1" },
      scope: { requiresChangeGrant: true },
    });
  });

  it("denies a 'binding' proposal when the access decision disallows it, with the decision's explanation and details", async () => {
    mockDecide.mockResolvedValueOnce({
      allowed: false,
      explanation: "Caller lacks agent_config:update",
      code: "missing_change_grant",
      reason: "no_grant",
    });
    await expect(
      assertCanResolveProposal({
        ...baseInput,
        proposal: { kind: "binding", targetId: "agent-1" },
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Caller lacks agent_config:update",
      details: { code: "missing_change_grant", reason: "no_grant" },
    });
  });
});
