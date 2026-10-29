import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginBoardCli, readBoardAuthStore } from "../client/board-auth.js";

// Synthetic token; never a real credential.
const MINTED = "pcp_board_test_minted_value";
const API = "http://cli-login.test";

function tmpStore(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-login-")), "auth.json");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockServer(meStatus: number) {
  const calls: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = new Headers(init?.headers).get("authorization");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, auth, body });
    if (method === "POST" && u.pathname === "/api/cli-auth/challenges") {
      return json(201, {
        id: "ch-1", token: "poll-token", boardApiToken: MINTED,
        approvalPath: "/cli-auth/ch-1", approvalUrl: null, pollPath: "/cli-auth/challenges/ch-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(), suggestedPollIntervalMs: 500,
      });
    }
    if (method === "GET" && u.pathname === "/api/cli-auth/challenges/ch-1") {
      return json(200, { status: "approved" });
    }
    if (method === "GET" && u.pathname === "/api/cli-auth/me") {
      return meStatus === 200
        ? json(200, { userId: "user-1", user: { id: "user-1" } })
        : json(meStatus, { error: "Board API key scope does not permit this route" });
    }
    if (method === "POST" && u.pathname === "/api/cli-auth/revoke-current") {
      return json(200, { revoked: true });
    }
    return json(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("loginBoardCli with the default plugin_ops scope", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drives login -> approved -> me -> store and never prints the token", async () => {
    const calls = mockServer(200);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const store = tmpStore();
    const result = await loginBoardCli({
      apiBase: API, requestedAccess: "board", storePath: store, openBrowser: false,
    });
    const printed = [...errSpy.mock.calls, ...logSpy.mock.calls].flat().join("\n");
    errSpy.mockRestore();
    logSpy.mockRestore();

    expect(calls[0].body).toMatchObject({ requestedKeyScope: { kind: "plugin_ops" } });
    const me = calls.find((c) => c.path === "/api/cli-auth/me");
    expect(me?.auth).toBe(`Bearer ${MINTED}`);
    expect(result.userId).toBe("user-1");
    const cred = readBoardAuthStore(store).credentials[API];
    expect(cred?.userId).toBe("user-1");
    expect(cred?.token === MINTED).toBe(true);
    expect(printed.includes(MINTED)).toBe(false);
    expect(calls.some((c) => c.path === "/api/cli-auth/revoke-current")).toBe(false);
  });

  it("revokes the just-minted key and stores nothing when /cli-auth/me fails", async () => {
    const calls = mockServer(403);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = tmpStore();
    let message = "";
    await loginBoardCli({ apiBase: API, requestedAccess: "board", storePath: store, openBrowser: false })
      .catch((e: Error) => { message = e.message; });
    errSpy.mockRestore();

    expect(message).toMatch(/identity check failed/);
    expect(message).toMatch(/was revoked/);
    expect(message.includes(MINTED)).toBe(false);
    const revoke = calls.find((c) => c.path === "/api/cli-auth/revoke-current");
    expect(revoke?.method).toBe("POST");
    expect(revoke?.auth).toBe(`Bearer ${MINTED}`);
    expect(fs.existsSync(store)).toBe(false);
  });
});

describe("loginBoardCli poll failure tolerance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // pollResults: each entry is a status code to answer the poll with (200 = approved)
  // "pending" for a still-waiting challenge, or "network" to make fetch itself throw.
  function pollServer(pollResults: Array<number | "network" | "pending">) {
    let pollCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST" && u.pathname === "/api/cli-auth/challenges") {
          return json(201, {
            id: "ch-1", token: "poll-token", boardApiToken: MINTED,
            approvalPath: "/cli-auth/ch-1", approvalUrl: null, pollPath: "/cli-auth/challenges/ch-1",
            expiresAt: new Date(Date.now() + 600_000).toISOString(), suggestedPollIntervalMs: 500,
          });
        }
        if (method === "GET" && u.pathname === "/api/cli-auth/challenges/ch-1") {
          const next = pollResults[Math.min(pollCalls, pollResults.length - 1)];
          pollCalls += 1;
          if (next === "network") throw new TypeError("fetch failed");
          if (next === "pending") return json(200, { status: "pending" });
          return next === 200
            ? json(200, { status: "approved" })
            : json(next, { error: `poll failed ${next}` });
        }
        if (method === "GET" && u.pathname === "/api/cli-auth/me") {
          return json(200, { userId: "user-1", user: { id: "user-1" } });
        }
        return json(404, { error: "not found" });
      }),
    );
    return { pollCalls: () => pollCalls };
  }

  async function runLogin() {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = loginBoardCli({
      apiBase: API, requestedAccess: "board", storePath: tmpStore(), openBrowser: false,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: Error) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    errSpy.mockRestore();
    return result;
  }

  it("keeps polling through two transient failures and still logs in", async () => {
    const server = pollServer([503, "network", 200]);
    const result = await runLogin();
    expect(result.ok).toBe(true);
    expect(server.pollCalls()).toBe(3);
  });

  it("gives up after three consecutive transient failures", async () => {
    const server = pollServer([502, 502, 502, 200]);
    const result = await runLogin();
    expect(result.ok).toBe(false);
    expect(server.pollCalls()).toBe(3);
  });

  it("resets the failure count after a successful poll", async () => {
    const server = pollServer([503, 503, "pending", 503, 503, 200]);
    const result = await runLogin();
    expect(result.ok).toBe(true);
    expect(server.pollCalls()).toBe(6);
  });

  it("rethrows a permanent 4xx poll error immediately without retrying", async () => {
    const server = pollServer([403, 200]);
    const result = await runLogin();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/poll failed 403/);
    expect(server.pollCalls()).toBe(1);
  });
});
