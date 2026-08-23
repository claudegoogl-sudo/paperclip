import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isExternalLoggingTarget, isInternalKeyTarget, resolveSpawnApiKey } from "./execute.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.resolve(__dirname, "../../skills/paperclip-task-bridge/paperclip-task.mjs");
const apiKey = "pc_test_secret_should_not_print";

type RequestRecord = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
};

function runHelper(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [helperPath, ...args], {
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("paperclip-task-bridge helper", () => {
  let server: http.Server;
  let baseUrl: string;
  let requests: RequestRecord[];

  beforeEach(async () => {
    requests = [];
    server = http.createServer(async (req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body,
      });

      res.setHeader("Content-Type", "application/json");
      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "bad auth" }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/agents/me") {
        res.end(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", companyId: "22222222-2222-4222-8222-222222222222" }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/agents/me/inbox-lite") {
        res.end(JSON.stringify([
          {
            id: "33333333-3333-4333-8333-333333333333",
            identifier: "PAP-123",
            title: "Existing task",
            status: "todo",
            priority: "medium",
            assigneeAgentId: "11111111-1111-4111-8111-111111111111",
            updatedAt: "2026-06-26T00:00:00.000Z",
          },
        ]));
        return;
      }
      if (req.method === "POST" && req.url === "/api/companies/22222222-2222-4222-8222-222222222222/issues") {
        res.statusCode = 201;
        res.end(JSON.stringify({
          id: "44444444-4444-4444-8444-444444444444",
          identifier: "PAP-124",
          title: body.title,
          status: body.status ?? "todo",
          priority: body.priority,
          assigneeAgentId: body.assigneeAgentId ?? null,
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/issues/PAP-123/comments") {
        res.statusCode = 201;
        res.end(JSON.stringify({
          id: "55555555-5555-4555-8555-555555555555",
          issueId: "33333333-3333-4333-8333-333333333333",
          authorType: "agent",
          authorAgentId: "11111111-1111-4111-8111-111111111111",
          createdAt: "2026-06-26T00:00:00.000Z",
        }));
        return;
      }
      if (req.method === "PATCH" && req.url === "/api/issues/PAP-123") {
        res.end(JSON.stringify({
          id: "33333333-3333-4333-8333-333333333333",
          identifier: "PAP-123",
          title: "Existing task",
          status: body.status,
          priority: "medium",
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    baseUrl = `http://127.0.0.1:${address.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function env() {
    return {
      PAPERCLIP_API_URL: baseUrl,
      PAPERCLIP_BRIDGE_API_KEY: apiKey,
      PAPERCLIP_COMPANY_ID: "22222222-2222-4222-8222-222222222222",
      PAPERCLIP_AGENT_ID: "11111111-1111-4111-8111-111111111111",
      PAPERCLIP_RUN_ID: "66666666-6666-4666-8666-666666666666",
    };
  }

  it("lists assigned tasks without printing credentials", async () => {
    const result = await runHelper(["list-assigned"], env());

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"command": "list-assigned"');
    expect(result.stdout).toContain('"identifier": "PAP-123"');
    expect(result.stdout).not.toContain(apiKey);
    expect(result.stderr).not.toContain(apiKey);
    expect(requests.some((request) => request.url === "/api/agents/me/inbox-lite")).toBe(true);
  });

  it("creates tasks assigned to the authenticated agent by default", async () => {
    const result = await runHelper(["create-task", "--title", "Bridge task", "--description", "Created from Hermes"], env());

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"identifier": "PAP-124"');
    const createRequest = requests.find((request) => request.method === "POST" && request.url.includes("/companies/"));
    expect(createRequest?.headers["x-paperclip-run-id"]).toBe("66666666-6666-4666-8666-666666666666");
    expect(createRequest?.body).toMatchObject({
      title: "Bridge task",
      description: "Created from Hermes",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.stdout).not.toContain(apiKey);
  });

  it("comments and updates status through direct issue identifier routes", async () => {
    const comment = await runHelper(["comment", "--issue", "PAP-123", "--body", "Progress from Hermes"], env());
    const update = await runHelper(["update-status", "--issue", "PAP-123", "--status", "in_review", "--comment", "Ready"], env());

    expect(comment.code).toBe(0);
    expect(update.code).toBe(0);
    const commentRequest = requests.find((request) => request.method === "POST" && request.url.includes("/comments"));
    const patchRequest = requests.find((request) => request.method === "PATCH");
    expect(commentRequest?.body).toMatchObject({ body: "Progress from Hermes" });
    expect(patchRequest?.body).toMatchObject({ status: "in_review", comment: "Ready" });
    expect(comment.stdout + update.stdout).not.toContain(apiKey);
  });
});

describe("resolveSpawnApiKey (external-logging key posture)", () => {
  // Synthetic, shape-valid fixtures only — never a live key value.
  const BOUND_BRIDGE_KEY = "pc_task_bridge_synthetic_fixture_key";
  const BROAD_RUN_TOKEN = "pc_broad_run_scoped_authtoken_fixture";

  it("keeps a bound task_bridge key for openrouter (never the broad authToken)", () => {
    const key = resolveSpawnApiKey({
      boundKey: BOUND_BRIDGE_KEY,
      authToken: BROAD_RUN_TOKEN,
      provider: "openrouter",
      model: "stealth/ox-alpha",
    });
    expect(key).toBe(BOUND_BRIDGE_KEY);
    expect(key).not.toBe(BROAD_RUN_TOKEN);
  });

  it("fails closed for openrouter when no scoped key is bound", () => {
    expect(() =>
      resolveSpawnApiKey({
        boundKey: undefined,
        authToken: BROAD_RUN_TOKEN,
        provider: "openrouter",
        model: "some-model",
      }),
    ).toThrow(/Refusing to spawn/);
  });

  it("fails closed for a cloaked stealth model even when provider is auto", () => {
    expect(() =>
      resolveSpawnApiKey({
        boundKey: undefined,
        authToken: BROAD_RUN_TOKEN,
        provider: "auto",
        model: "stealth/ox-alpha",
      }),
    ).toThrow(/Refusing to spawn/);
  });

  // Default-deny inversion — a denylist would have MISSED both of the following
  // (they leaked the broad key on the pre-inversion code); an internal allowlist
  // fails them closed by construction.
  it("fails closed for an unknown/new external provider not in any denylist", () => {
    expect(() =>
      resolveSpawnApiKey({
        boundKey: undefined,
        authToken: BROAD_RUN_TOKEN,
        provider: "some-future-logging-provider",
        model: "brand-new-model",
      }),
    ).toThrow(/Refusing to spawn/);
  });

  it("fails closed for provider=auto with a benign (non-stealth) model name", () => {
    // Threat (b): auto-routing to an external upstream under a model name that
    // matches no stealth pattern. The provider is not on the internal allowlist,
    // so the broad key is never injected.
    expect(() =>
      resolveSpawnApiKey({
        boundKey: undefined,
        authToken: BROAD_RUN_TOKEN,
        provider: "auto",
        model: "gpt-4o",
      }),
    ).toThrow(/Refusing to spawn/);
  });

  it("fails closed for a known external provider under a benign model name", () => {
    // e.g. copilot / zai / minimax — external upstreams that were never in the
    // openrouter-only denylist.
    for (const provider of ["copilot", "zai", "minimax", "nous", "huggingface"]) {
      expect(() =>
        resolveSpawnApiKey({
          boundKey: undefined,
          authToken: BROAD_RUN_TOKEN,
          provider,
          model: "some-model",
        }),
      ).toThrow(/Refusing to spawn/);
    }
  });

  it("keeps a bound task_bridge key for an unknown external provider", () => {
    // The sanctioned per-agent opt-in works for ANY provider, allowlisted or not.
    const key = resolveSpawnApiKey({
      boundKey: BOUND_BRIDGE_KEY,
      authToken: BROAD_RUN_TOKEN,
      provider: "some-future-logging-provider",
      model: "brand-new-model",
    });
    expect(key).toBe(BOUND_BRIDGE_KEY);
    expect(key).not.toBe(BROAD_RUN_TOKEN);
  });

  it("keeps the authToken fallback for internal providers (no regression)", () => {
    const key = resolveSpawnApiKey({
      boundKey: undefined,
      authToken: BROAD_RUN_TOKEN,
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(key).toBe(BROAD_RUN_TOKEN);
  });

  it("never throws for an internal provider even without any key", () => {
    const key = resolveSpawnApiKey({
      boundKey: undefined,
      authToken: undefined,
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(key).toBeUndefined();
  });

  it("classifies non-allowlisted targets as external by default (default-deny)", () => {
    expect(isExternalLoggingTarget("openrouter", "any-model")).toBe(true);
    expect(isExternalLoggingTarget("auto", "stealth/ox-alpha")).toBe(true);
    expect(isExternalLoggingTarget("anthropic", "claude-sonnet-4")).toBe(false);
    // Previously `false` under the denylist (a miss). auto is not on the
    // internal allowlist, so it is external by default now.
    expect(isExternalLoggingTarget("auto", undefined)).toBe(true);
    expect(isExternalLoggingTarget("some-future-logging-provider", "m")).toBe(true);
    expect(isExternalLoggingTarget(undefined, undefined)).toBe(true);
  });

  it("treats only the internal allowlist as a trusted key target", () => {
    expect(isInternalKeyTarget("anthropic", "claude-sonnet-4")).toBe(true);
    expect(isInternalKeyTarget("claude_local", undefined)).toBe(true);
    // Even an allowlisted provider is downgraded when the model slug is cloaked.
    expect(isInternalKeyTarget("anthropic", "stealth/ox-alpha")).toBe(false);
    expect(isInternalKeyTarget("auto", undefined)).toBe(false);
    expect(isInternalKeyTarget("openrouter", "any-model")).toBe(false);
    expect(isInternalKeyTarget(undefined, undefined)).toBe(false);
  });
});
