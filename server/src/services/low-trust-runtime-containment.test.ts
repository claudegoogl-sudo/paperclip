import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { TrustPresetResolution } from "./trust-preset-resolver.js";
import {
  assertLowTrustRuntimeServicesAllowed,
  assertLowTrustWorkspaceIsolation,
  isLowTrustRuntimeManagementAllowed,
  LOW_TRUST_RUNTIME_MANAGEMENT_TOOL_CLASS,
} from "./low-trust-runtime-containment.js";

const STANDARD_RESOLUTION: TrustPresetResolution = {
  kind: "standard",
  preset: "standard",
  boundary: null,
  sourcePresets: {},
};

const DENIED_RESOLUTION: TrustPresetResolution = {
  kind: "denied",
  reason: "conflicting_low_trust_boundary",
  source: "project",
  detail: "Project and agent trust policies disagree.",
  sourcePresets: {},
};

function lowTrustResolution(
  boundaryOverrides: Record<string, unknown> = {},
): TrustPresetResolution {
  return {
    kind: "low_trust_review",
    preset: "low_trust_review",
    boundary: { mode: "low_trust_review", companyId: "company-1", ...boundaryOverrides },
    sourcePresets: {},
  } as TrustPresetResolution;
}

function makeAncestryDb(queue: ({ id: string; companyId: string; parentId: string | null } | null)[]) {
  let index = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const next = queue[index++] ?? null;
          return Promise.resolve(next ? [next] : []);
        },
      }),
    }),
  } as unknown as Db;
}

describe("isLowTrustRuntimeManagementAllowed", () => {
  it("is false for a non-low_trust_review resolution", () => {
    expect(isLowTrustRuntimeManagementAllowed(STANDARD_RESOLUTION)).toBe(false);
    expect(isLowTrustRuntimeManagementAllowed(DENIED_RESOLUTION)).toBe(false);
  });

  it("is true when the boundary's allowedToolClasses includes runtime.manage", () => {
    const resolution = lowTrustResolution({ allowedToolClasses: [LOW_TRUST_RUNTIME_MANAGEMENT_TOOL_CLASS] });
    expect(isLowTrustRuntimeManagementAllowed(resolution)).toBe(true);
  });

  it("is false when allowedToolClasses is absent or does not include runtime.manage", () => {
    expect(isLowTrustRuntimeManagementAllowed(lowTrustResolution())).toBe(false);
    expect(
      isLowTrustRuntimeManagementAllowed(lowTrustResolution({ allowedToolClasses: ["other.tool"] })),
    ).toBe(false);
  });
});

describe("assertLowTrustWorkspaceIsolation", () => {
  const validIsolationBase = {
    isolatedWorkspacesEnabled: true,
    effectiveExecutionWorkspaceMode: "isolated_workspace",
    selectedEnvironmentDriver: "sandbox",
  };

  it("throws with the denial's own detail/reason/source for a denied resolution", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...validIsolationBase,
        resolution: DENIED_RESOLUTION,
        issue: null,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Project and agent trust policies disagree.",
      details: { code: "conflicting_low_trust_boundary", source: "project" },
    });
  });

  it("is a no-op for a standard resolution regardless of the other inputs", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        resolution: STANDARD_RESOLUTION,
        isolatedWorkspacesEnabled: false,
        effectiveExecutionWorkspaceMode: null,
        selectedEnvironmentDriver: null,
        issue: null,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when isolated workspaces are not enabled", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...validIsolationBase,
        isolatedWorkspacesEnabled: false,
        resolution: lowTrustResolution({ rootIssueId: "root-1" }),
        issue: { companyId: "company-1", id: "root-1" },
      }),
    ).rejects.toMatchObject({ details: { code: "low_trust_isolation_unavailable" } });
  });

  it("throws when the execution workspace mode is not isolated_workspace", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...validIsolationBase,
        effectiveExecutionWorkspaceMode: "shared_workspace",
        resolution: lowTrustResolution({ rootIssueId: "root-1" }),
        issue: { companyId: "company-1", id: "root-1" },
      }),
    ).rejects.toMatchObject({ details: { code: "low_trust_requires_isolated_workspace" } });
  });

  it("throws a boundary mismatch when issue is null", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...validIsolationBase,
        resolution: lowTrustResolution({ rootIssueId: "root-1" }),
        issue: null,
      }),
    ).rejects.toMatchObject({ details: { code: "low_trust_boundary_mismatch" } });
  });

  it("throws a boundary mismatch when the issue's company does not match the boundary", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...validIsolationBase,
        resolution: lowTrustResolution({ rootIssueId: "root-1" }),
        issue: { companyId: "other-company", id: "root-1" },
      }),
    ).rejects.toMatchObject({ details: { code: "low_trust_boundary_mismatch" } });
  });

  it("passes when the issue directly matches the boundary's rootIssueId", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...validIsolationBase,
        resolution: lowTrustResolution({ rootIssueId: "root-1" }),
        issue: { companyId: "company-1", id: "root-1" },
      }),
    ).resolves.toBeUndefined();
  });

  it("passes when the issue's projectId matches the boundary's projectIds", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...validIsolationBase,
        resolution: lowTrustResolution({ projectIds: ["project-1"] }),
        issue: { companyId: "company-1", id: "unrelated-issue", projectId: "project-1" },
      }),
    ).resolves.toBeUndefined();
  });

  it("falls back to a DB ancestry walk and passes when a parent reaches the root issue", async () => {
    const db = makeAncestryDb([
      { id: "child-1", companyId: "company-1", parentId: "root-1" },
    ]);
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...validIsolationBase,
        db,
        resolution: lowTrustResolution({ rootIssueId: "root-1" }),
        issue: { companyId: "company-1", id: "child-1" },
      }),
    ).resolves.toBeUndefined();
  });

  it("throws a boundary mismatch when the DB ancestry walk never reaches the root issue", async () => {
    const db = makeAncestryDb([null]);
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...validIsolationBase,
        db,
        resolution: lowTrustResolution({ rootIssueId: "root-1" }),
        issue: { companyId: "company-1", id: "orphan-1" },
      }),
    ).rejects.toMatchObject({ details: { code: "low_trust_boundary_mismatch" } });
  });

  it("throws a boundary mismatch when an ancestor belongs to a different company", async () => {
    const db = makeAncestryDb([
      { id: "child-1", companyId: "other-company", parentId: "root-1" },
    ]);
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...validIsolationBase,
        db,
        resolution: lowTrustResolution({ rootIssueId: "root-1" }),
        issue: { companyId: "company-1", id: "child-1" },
      }),
    ).rejects.toMatchObject({ details: { code: "low_trust_boundary_mismatch" } });
  });

  it("throws when the environment driver is not sandbox, even after the boundary check passes", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...validIsolationBase,
        selectedEnvironmentDriver: "direct",
        resolution: lowTrustResolution({ rootIssueId: "root-1" }),
        issue: { companyId: "company-1", id: "root-1" },
      }),
    ).rejects.toMatchObject({ details: { code: "low_trust_requires_sandbox_environment" } });
  });
});

describe("assertLowTrustRuntimeServicesAllowed", () => {
  it("throws with the denial's own detail/reason/source for a denied resolution", () => {
    expect(() =>
      assertLowTrustRuntimeServicesAllowed({ resolution: DENIED_RESOLUTION, runtimeServiceCount: 1 }),
    ).toThrow("Project and agent trust policies disagree.");
  });

  it("is a no-op for a standard resolution", () => {
    expect(() =>
      assertLowTrustRuntimeServicesAllowed({ resolution: STANDARD_RESOLUTION, runtimeServiceCount: 5 }),
    ).not.toThrow();
  });

  it("is a no-op for low_trust_review when no runtime services are requested", () => {
    expect(() =>
      assertLowTrustRuntimeServicesAllowed({ resolution: lowTrustResolution(), runtimeServiceCount: 0 }),
    ).not.toThrow();
  });

  it("is a no-op when runtime services are requested and the boundary grants runtime.manage", () => {
    const resolution = lowTrustResolution({ allowedToolClasses: [LOW_TRUST_RUNTIME_MANAGEMENT_TOOL_CLASS] });
    expect(() =>
      assertLowTrustRuntimeServicesAllowed({ resolution, runtimeServiceCount: 2 }),
    ).not.toThrow();
  });

  it("throws when runtime services are requested but the boundary does not grant runtime.manage", () => {
    expect(() =>
      assertLowTrustRuntimeServicesAllowed({ resolution: lowTrustResolution(), runtimeServiceCount: 1 }),
    ).toThrow("Low-trust execution cannot start runtime services unless the boundary grants runtime.manage.");
  });
});
