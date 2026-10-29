import { afterEach, describe, expect, it, vi } from "vitest";
import { gitHubApiBase, ghFetch, isGitHubDotCom, resolveRawGitHubUrl } from "./github-fetch.js";

describe("isGitHubDotCom", () => {
  it("matches github.com and www.github.com case-insensitively", () => {
    expect(isGitHubDotCom("github.com")).toBe(true);
    expect(isGitHubDotCom("WWW.GITHUB.COM")).toBe(true);
    expect(isGitHubDotCom("GitHub.com")).toBe(true);
  });

  it("does not match a subdomain or GitHub Enterprise host", () => {
    expect(isGitHubDotCom("api.github.com")).toBe(false);
    expect(isGitHubDotCom("github.enterprise.example.com")).toBe(false);
    expect(isGitHubDotCom("not-github.com")).toBe(false);
  });
});

describe("gitHubApiBase", () => {
  it("resolves to the public GitHub API host for github.com", () => {
    expect(gitHubApiBase("github.com")).toBe("https://api.github.com");
  });

  it("resolves to the /api/v3 path for a GitHub Enterprise host", () => {
    expect(gitHubApiBase("github.internal.example.com")).toBe(
      "https://github.internal.example.com/api/v3",
    );
  });
});

describe("resolveRawGitHubUrl", () => {
  it("builds a raw.githubusercontent.com URL for github.com", () => {
    expect(resolveRawGitHubUrl("github.com", "owner", "repo", "main", "path/to/file.md")).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/path/to/file.md",
    );
  });

  it("builds a /raw/ path for a GitHub Enterprise host", () => {
    expect(resolveRawGitHubUrl("github.internal.example.com", "owner", "repo", "main", "file.md")).toBe(
      "https://github.internal.example.com/raw/owner/repo/main/file.md",
    );
  });

  it("strips leading slashes from the file path", () => {
    expect(resolveRawGitHubUrl("github.com", "owner", "repo", "main", "///file.md")).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/file.md",
    );
  });
});

describe("ghFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the response from a successful fetch", async () => {
    const response = new Response("ok");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(ghFetch("https://github.com/owner/repo")).resolves.toBe(response);
  });

  it("wraps a network failure as an unprocessable error naming the hostname", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(ghFetch("https://github.internal.example.com/owner/repo")).rejects.toMatchObject({
      status: 422,
      message:
        "Could not connect to github.internal.example.com — ensure the URL points to a GitHub or GitHub Enterprise instance",
    });
  });
});
