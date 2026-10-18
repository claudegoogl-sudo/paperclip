import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool } from "./project-tools.js";

const base = {
  name: "list_projects", arguments: {}, apiUrl: "http://localhost:3100/api", token: "test-token",
  companyId: "company-1", issueId: "issue-1", agentId: "agent-1", conversation: false,
};

describe("project tool API call", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (response: Response) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("returns the project list from the authenticated company route", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify([{ id: "project-1" }]), { status: 200 }));
    await expect(callProjectTool(base)).resolves.toEqual({ projects: [{ id: "project-1" }] });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3100/api/companies/company-1/projects",
      expect.objectContaining({ method: "GET" }));
  });

  it("reports the status when a proxy returns a non-JSON error page", async () => {
    stubFetch(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(callProjectTool(base)).rejects.toThrow("Project tool failed (502)");
  });

  it("keeps the API error message when the error body is JSON", async () => {
    stubFetch(new Response(JSON.stringify({ error: "Project not found" }), { status: 404 }));
    await expect(callProjectTool(base)).rejects.toThrow("Project not found");
  });

  it("reports the status when the error body is JSON null", async () => {
    stubFetch(new Response("null", { status: 500 }));
    await expect(callProjectTool(base)).rejects.toThrow("Project tool failed (500)");
  });

  it.each(["null", "<html>ok</html>", "\"text\""])("rejects a successful response with an invalid body (%s)", async (body) => {
    stubFetch(new Response(body, { status: 200 }));
    await expect(callProjectTool(base)).rejects.toThrow("Project tool returned an invalid response");
  });
});
