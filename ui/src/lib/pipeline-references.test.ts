import { describe, expect, it } from "vitest";
import { extractWorkReferences, referenceFieldKeys } from "./pipeline-references";

describe("extractWorkReferences", () => {
  it("returns an empty array when there is nothing to reference", () => {
    expect(extractWorkReferences({})).toEqual([]);
    expect(extractWorkReferences({ fields: null, workspaceRef: null })).toEqual([]);
  });

  it("extracts the dedicated workspaceRef column first", () => {
    const refs = extractWorkReferences({
      workspaceRef: { path: "/repo/app", branch: "main" },
    });
    expect(refs).toEqual([
      { id: "workspaceRef", kind: "workspace", label: "Workspace folder", path: "/repo/app", branch: "main" },
    ]);
  });

  it("ignores a workspaceRef that carries no path-like field", () => {
    expect(extractWorkReferences({ workspaceRef: { note: "nothing useful here" } })).toEqual([]);
  });

  it("extracts a bare http(s) string field as a url reference", () => {
    const refs = extractWorkReferences({ fields: { docsLink: "https://example.com/doc" } });
    expect(refs).toEqual([{ id: "docsLink", kind: "url", label: "Docs Link", url: "https://example.com/doc" }]);
  });

  it("extracts an object url reference, falling back from url to href", () => {
    const refs = extractWorkReferences({
      fields: { reference: { href: "https://example.com/x", label: "External doc" } },
    });
    expect(refs).toEqual([{ id: "reference", kind: "url", label: "External doc", url: "https://example.com/x" }]);
  });

  it("extracts an issue reference when the issueId/issueIdentifier fields are present", () => {
    const refs = extractWorkReferences({
      fields: { linkedIssue: { issueId: "abc123", issueIdentifier: "PAP-42", title: "Fix the thing" } },
    });
    expect(refs).toEqual([
      { id: "linkedIssue", kind: "issue", label: "Fix the thing", issueId: "abc123", identifier: "PAP-42" },
    ]);
  });

  it("extracts a workspace reference from a fields entry carrying a path/folder key", () => {
    const refs = extractWorkReferences({
      fields: { workdir: { folder: "packages/ui", branch: "feature/x" } },
    });
    expect(refs).toEqual([
      { id: "workdir", kind: "workspace", label: "Workdir", path: "packages/ui", branch: "feature/x" },
    ]);
  });

  it("returns one reference per recognized field and skips unrecognized ones", () => {
    const refs = extractWorkReferences({
      fields: {
        priority: "high",
        notes: "just some text",
        docsLink: "https://example.com",
      },
    });
    expect(refs).toEqual([{ id: "docsLink", kind: "url", label: "Docs Link", url: "https://example.com" }]);
  });

  it("does not treat a bare non-http string as a workspace path (only object shapes qualify)", () => {
    expect(extractWorkReferences({ fields: { workdir: "/repo/app" } })).toEqual([]);
  });

  it("does not treat an array value as a reference", () => {
    expect(extractWorkReferences({ fields: { tags: ["a", "b"] } })).toEqual([]);
  });

  it("ignores a record that claims kind url but has no url or href value", () => {
    expect(extractWorkReferences({ fields: { broken: { kind: "url", label: "Broken" } } })).toEqual([]);
  });

  it("does not auto-detect an issue from a plain id/identifier field without kind or the issueId/issueIdentifier names", () => {
    // `id` and `identifier` alone are too generic to count as issue-shaped; the
    // dedicated `issueId`/`issueIdentifier` field names (or an explicit kind) are required.
    expect(extractWorkReferences({ fields: { related: { id: "abc", identifier: "PAP-1" } } })).toEqual([]);
  });

  it("still resolves id/identifier fallbacks once an explicit issue kind is given", () => {
    const refs = extractWorkReferences({
      fields: { related: { kind: "issue", id: "abc", identifier: "PAP-1" } },
    });
    expect(refs).toEqual([{ id: "related", kind: "issue", label: "Related", issueId: "abc", identifier: "PAP-1" }]);
  });

  it("does not dedupe workspaceRef against an equivalent fields entry", () => {
    const refs = extractWorkReferences({
      workspaceRef: { path: "/repo/app" },
      fields: { secondaryWorkdir: { path: "/repo/app" } },
    });
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.id)).toEqual(["workspaceRef", "secondaryWorkdir"]);
    expect(refs[0]).toMatchObject({ kind: "workspace", path: "/repo/app" });
    expect(refs[1]).toMatchObject({ kind: "workspace", path: "/repo/app" });
  });

  it("combines workspaceRef with multiple distinct fields references in field order", () => {
    const refs = extractWorkReferences({
      workspaceRef: { path: "/repo/app" },
      fields: {
        docsLink: "https://example.com/doc",
        linkedIssue: { issueId: "I-1" },
      },
    });
    expect(refs.map((r) => ({ id: r.id, kind: r.kind }))).toEqual([
      { id: "workspaceRef", kind: "workspace" },
      { id: "docsLink", kind: "url" },
      { id: "linkedIssue", kind: "issue" },
    ]);
  });
});

describe("referenceFieldKeys", () => {
  it("returns an empty set for missing or empty fields", () => {
    expect(referenceFieldKeys(null)).toEqual(new Set());
    expect(referenceFieldKeys(undefined)).toEqual(new Set());
    expect(referenceFieldKeys({})).toEqual(new Set());
  });

  it("includes only the keys that resolve to a typed reference", () => {
    const keys = referenceFieldKeys({
      priority: "high",
      docsLink: "https://example.com",
      linkedIssue: { issueId: "I-1" },
      workdir: { folder: "packages/ui" },
      broken: { kind: "url" },
    });
    expect(keys).toEqual(new Set(["docsLink", "linkedIssue", "workdir"]));
  });

  it("does not include the workspaceRef column key (it only inspects fields)", () => {
    // referenceFieldKeys has no concept of workspaceRef; it is purely a fields lookup.
    const keys = referenceFieldKeys({ workspaceRef: { path: "/repo/app" } });
    // "workspaceRef" here is just a fields key named that way, and it does resolve
    // because it carries a `path` field, matching the workspace-shaped branch.
    expect(keys).toEqual(new Set(["workspaceRef"]));
  });
});
