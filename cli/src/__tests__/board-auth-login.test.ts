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
