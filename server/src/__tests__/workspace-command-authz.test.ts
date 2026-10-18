import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectAgentAdapterWorkspaceCommandPaths,
  collectExecutionWorkspaceCommandPaths,
  collectIssueWorkspaceCommandPaths,
  collectProjectExecutionWorkspaceCommandPaths,
  collectProjectWorkspaceCommandPaths,
} from "../routes/workspace-command-authz.js";

function actorRequest(type: "agent" | "board"): Request {
  return { actor: { type } } as unknown as Request;
}

describe("workspace host-command mutation detection", () => {
  it.each([
    {
      name: "project execution policy commands",
      actual: () => collectProjectExecutionWorkspaceCommandPaths({
        workspaceRuntime: { commands: [{ name: "seed", command: "pnpm seed" }] },
      }),
      expected: "executionWorkspacePolicy.workspaceRuntime.commands[0].command",
    },
    {
      name: "project execution policy services",
      actual: () => collectProjectExecutionWorkspaceCommandPaths({
        workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] },
      }),
      expected: "executionWorkspacePolicy.workspaceRuntime.services[0].command",
    },
    {
      name: "project workspace jobs",
      actual: () => collectProjectWorkspaceCommandPaths({
        runtimeConfig: { workspaceRuntime: { jobs: [{ name: "build", command: "pnpm build" }] } },
      }),
      expected: "runtimeConfig.workspaceRuntime.jobs[0].command",
    },
    {
      name: "issue execution workspace services",
      actual: () => collectIssueWorkspaceCommandPaths({
        executionWorkspaceSettings: {
          workspaceRuntime: { services: [{ name: "web", command: "pnpm dev" }] },
        },
      }),
      expected: "executionWorkspaceSettings.workspaceRuntime.services[0].command",
    },
    {
      name: "execution workspace config commands",
      actual: () => collectExecutionWorkspaceCommandPaths({
        config: { workspaceRuntime: { commands: [{ name: "seed", command: "pnpm seed" }] } },
      }),
      expected: "config.workspaceRuntime.commands[0].command",
    },
    {
      name: "execution workspace metadata jobs",
      actual: () => collectExecutionWorkspaceCommandPaths({
        metadata: {
          config: { workspaceRuntime: { jobs: [{ name: "build", command: "pnpm build" }] } },
        },
      }),
      expected: "metadata.config.workspaceRuntime.jobs[0].command",
    },
  ])("detects $name", ({ actual, expected }) => {
    expect(actual()).toContain(expected);
  });

  it("ignores descriptive runtime entries without a command field", () => {
    expect(collectProjectExecutionWorkspaceCommandPaths({
      workspaceRuntime: {
        commands: [{ name: "seed" }],
        services: [{ name: "web", port: 3100 }],
        jobs: [null, "build"],
      },
    })).toEqual([]);
  });

  it("detects adapterConfig workspaceStrategy commands", () => {
    expect(
      collectAgentAdapterWorkspaceCommandPaths({
        workspaceStrategy: { provisionCommand: "pnpm provision" },
      }),
    ).toEqual(["adapterConfig.workspaceStrategy.provisionCommand"]);
  });

  it("returns no paths for adapterConfig without a workspaceStrategy", () => {
    expect(collectAgentAdapterWorkspaceCommandPaths({ role: "engineer" })).toEqual([]);
    expect(collectAgentAdapterWorkspaceCommandPaths(null)).toEqual([]);
  });

  it("detects the execution workspace cleanupCommand branch", () => {
    expect(
      collectExecutionWorkspaceCommandPaths({ config: { cleanupCommand: "rm -rf tmp" } }),
    ).toEqual(["config.cleanupCommand"]);
  });

  describe("assertNoAgentHostWorkspaceCommandMutation", () => {
    it("throws for an agent actor when host-executed command paths were touched", () => {
      expect(() =>
        assertNoAgentHostWorkspaceCommandMutation(actorRequest("agent"), [
          "config.provisionCommand",
        ]),
      ).toThrow(/Agent keys cannot modify host-executed workspace commands/);
    });

    it("does not throw for an agent actor when no command paths were touched", () => {
      expect(() =>
        assertNoAgentHostWorkspaceCommandMutation(actorRequest("agent"), []),
      ).not.toThrow();
    });

    it("does not throw for a board actor even when command paths were touched", () => {
      expect(() =>
        assertNoAgentHostWorkspaceCommandMutation(actorRequest("board"), [
          "config.provisionCommand",
        ]),
      ).not.toThrow();
    });
  });
});
