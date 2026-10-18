import { describe, expect, it } from "vitest";
import { renderStatePage } from "./render.js";
import type { KvStateSnapshot } from "./store.js";

function snapshot(overrides: Partial<KvStateSnapshot> = {}): KvStateSnapshot {
  return {
    entries: [],
    count: 0,
    revision: 0,
    ...overrides,
  };
}

describe("renderStatePage", () => {
  it("renders the empty-state row when there are no entries", () => {
    const html = renderStatePage(snapshot());
    expect(html).toContain("No values yet");
    expect(html).toContain('<tr class="empty">');
  });

  it("renders a row per entry with the key, value, and updatedAt", () => {
    const html = renderStatePage(
      snapshot({
        entries: [{ key: "foo", value: "bar", updatedAt: "2026-01-01T00:00:00.000Z" }],
        count: 1,
        revision: 3,
      }),
    );

    expect(html).toContain('<td class="key">foo</td>');
    expect(html).toContain('<td class="value">bar</td>');
    expect(html).toContain('<td class="updated">2026-01-01T00:00:00.000Z</td>');
  });

  it("HTML-escapes entry key and value to prevent injection into the page", () => {
    const html = renderStatePage(
      snapshot({
        entries: [{ key: "<script>alert(1)</script>", value: "a & b \"quoted\" 'val'", updatedAt: "now" }],
        count: 1,
      }),
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("a &amp; b &quot;quoted&quot; &#39;val&#39;");
  });

  it("renders the count and revision from the snapshot", () => {
    const html = renderStatePage(snapshot({ count: 7, revision: 42 }));
    expect(html).toContain('id="count">7<');
    expect(html).toContain('id="revision">42<');
  });

  it("embeds the tokenRequired flag as a JSON boolean literal", () => {
    expect(renderStatePage(snapshot(), { tokenRequired: true })).toContain(
      "const TOKEN_REQUIRED = true;",
    );
    expect(renderStatePage(snapshot())).toContain("const TOKEN_REQUIRED = false;");
    expect(renderStatePage(snapshot(), { tokenRequired: false })).toContain(
      "const TOKEN_REQUIRED = false;",
    );
  });
});
