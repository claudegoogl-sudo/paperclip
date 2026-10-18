// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliAuthPage, describeKeyTtl } from "./CliAuth";

const mockAccessApi = vi.hoisted(() => ({
  getCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
}));
const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ id: "challenge-1" }),
  useSearchParams: () => [new URLSearchParams("token=t")],
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function challenge(keyScope: string, keyTtlMs: number) {
  return {
    id: "challenge-1",
    status: "pending",
    command: "paperclipai connect",
    clientName: null,
    requestedAccess: "board",
    requestedCompanyId: null,
    requestedCompanyName: null,
    approvedAt: null,
    cancelledAt: null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    keyScope,
    keyTtlMs,
    approvedByUser: null,
    requiresSignIn: false,
    canApprove: true,
    currentUserId: "user-1",
  };
}

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
});

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CliAuthPage />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 20 && !container.querySelector("[data-testid=cli-auth-key-scope]"); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  return container;
}

describe("CliAuthPage key scope and expiry", () => {
  it("shows a standard key as full board authority with a 24 h expiry", async () => {
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockAccessApi.getCliAuthChallenge.mockResolvedValue(challenge("standard", 24 * 3600_000));
    const el = await render();
    const text = el.querySelector("[data-testid=cli-auth-key-scope]")?.textContent ?? "";
    expect(text).toContain("Full board authority (standard)");
    expect(text).toContain("expires in 24 h");
  });

  it("shows a plugin_ops key with a 30 day expiry", async () => {
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockAccessApi.getCliAuthChallenge.mockResolvedValue(challenge("plugin_ops", 30 * 24 * 3600_000));
    const el = await render();
    const text = el.querySelector("[data-testid=cli-auth-key-scope]")?.textContent ?? "";
    expect(text).toContain("Plugin operations (plugin_ops)");
    expect(text).toContain("expires in 30 days");
  });

  it("formats unknown TTLs safely", () => {
    expect(describeKeyTtl(undefined)).toBe("unknown");
  });
});
