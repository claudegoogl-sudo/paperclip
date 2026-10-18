import { describe, expect, it } from "vitest";
import { remarkSoftBreaks } from "./remark-soft-breaks";

// The plugin operates on a minimal node shape (type/value/children) rather
// than the full mdast spec, so hand-built literal trees exercise exactly
// what `transformNode` reads and mutates, without pulling in a parser.
type TextNode = { type: "text"; value: string };
type BreakNode = { type: "break" };
type ParentNode = { type: string; children: unknown[] };

function textNode(value: string): TextNode {
  return { type: "text", value };
}

function paragraph(children: unknown[]): ParentNode {
  return { type: "paragraph", children };
}

function transform(tree: unknown) {
  const transformer = remarkSoftBreaks();
  transformer(tree as never);
  return tree;
}

describe("remarkSoftBreaks", () => {
  it("splits a single embedded newline into a break between two text nodes", () => {
    const tree = paragraph([textNode("hello\nworld")]);

    transform(tree);

    expect(tree.children).toEqual([
      { type: "text", value: "hello" },
      { type: "break" },
      { type: "text", value: "world" },
    ]);
  });

  it("collapses a lone newline value into a single break with no empty text nodes", () => {
    const tree = paragraph([textNode("\n")]);

    transform(tree);

    expect(tree.children).toEqual([{ type: "break" }]);
  });

  it("produces a leading break (no empty text node) for a leading newline", () => {
    const tree = paragraph([textNode("\nfoo")]);

    transform(tree);

    expect(tree.children).toEqual([{ type: "break" }, { type: "text", value: "foo" }]);
  });

  it("produces a trailing break (no empty text node) for a trailing newline", () => {
    const tree = paragraph([textNode("foo\n")]);

    transform(tree);

    expect(tree.children).toEqual([{ type: "text", value: "foo" }, { type: "break" }]);
  });

  it("emits a break for every newline, including consecutive ones", () => {
    const tree = paragraph([textNode("a\n\nb")]);

    transform(tree);

    expect(tree.children).toEqual([
      { type: "text", value: "a" },
      { type: "break" },
      { type: "break" },
      { type: "text", value: "b" },
    ]);
  });

  it("leaves text nodes without a newline untouched", () => {
    const tree = paragraph([textNode("no breaks here")]);

    transform(tree);

    expect(tree.children).toEqual([{ type: "text", value: "no breaks here" }]);
  });

  it("recurses into nested children to find and split text nodes", () => {
    const tree = paragraph([
      { type: "strong", children: [textNode("em\nphasis")] },
    ]);

    transform(tree);

    expect(tree.children).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", value: "em" },
          { type: "break" },
          { type: "text", value: "phasis" },
        ],
      },
    ]);
  });

  it("continues processing later siblings after splicing in a replacement", () => {
    const tree = paragraph([textNode("a\nb"), textNode("tail")]);

    transform(tree);

    expect(tree.children).toEqual([
      { type: "text", value: "a" },
      { type: "break" },
      { type: "text", value: "b" },
      { type: "text", value: "tail" },
    ]);
  });

  it("is idempotent: running it again on an already-split tree changes nothing further", () => {
    const tree = paragraph([textNode("a\nb")]);

    transform(tree);
    const once = JSON.parse(JSON.stringify(tree.children));
    transform(tree);

    expect(tree.children).toEqual(once);
  });

  it("does nothing to a leaf node with no children array", () => {
    const leaf = { type: "break" };

    expect(() => transform(leaf)).not.toThrow();
    expect(leaf).toEqual({ type: "break" });
  });

  it("ignores non-text children even if they carry a string value field", () => {
    const tree = paragraph([{ type: "inlineCode", value: "a\nb" }]);

    transform(tree);

    expect(tree.children).toEqual([{ type: "inlineCode", value: "a\nb" }]);
  });

  it("returns a transformer function from calling remarkSoftBreaks()", () => {
    const transformer = remarkSoftBreaks();
    expect(typeof transformer).toBe("function");
  });
});
