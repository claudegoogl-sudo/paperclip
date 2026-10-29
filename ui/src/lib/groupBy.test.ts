import { describe, expect, it } from "vitest";
import { groupBy } from "./groupBy";

describe("groupBy", () => {
  it("groups items by the key selector into a record of arrays", () => {
    const items = [
      { type: "fruit", name: "apple" },
      { type: "veggie", name: "carrot" },
      { type: "fruit", name: "banana" },
    ];

    const result = groupBy(items, (item) => item.type);

    expect(result).toEqual({
      fruit: [
        { type: "fruit", name: "apple" },
        { type: "fruit", name: "banana" },
      ],
      veggie: [{ type: "veggie", name: "carrot" }],
    });
  });

  it("returns an empty object for an empty array", () => {
    const result = groupBy<{ id: string }>([], (item) => item.id);
    expect(result).toEqual({});
  });

  it("puts every item into a single group when the key selector always returns the same key", () => {
    const items = [1, 2, 3, 4];

    const result = groupBy(items, () => "all");

    expect(result).toEqual({ all: [1, 2, 3, 4] });
    expect(Object.keys(result)).toEqual(["all"]);
  });

  it("gives every item its own group when the key selector is unique per item", () => {
    const items = ["a", "b", "c"];

    const result = groupBy(items, (item) => item);

    expect(result).toEqual({ a: ["a"], b: ["b"], c: ["c"] });
  });

  it("preserves original item order within each group", () => {
    const items = [
      { bucket: "x", order: 1 },
      { bucket: "y", order: 2 },
      { bucket: "x", order: 3 },
      { bucket: "x", order: 4 },
    ];

    const result = groupBy(items, (item) => item.bucket);

    expect(result.x.map((item) => item.order)).toEqual([1, 3, 4]);
    expect(result.y.map((item) => item.order)).toEqual([2]);
  });

  it("coerces a numeric key returned by the key selector into a string key", () => {
    const items = [1, 2, 11, 2];

    // The key selector's declared return type is string, but a number is
    // assignable to the index signature's key position and gets coerced to
    // its string form by normal object-key semantics.
    const result = groupBy(items, (item) => item % 10 as unknown as string);

    expect(result).toEqual({
      "1": [1, 11],
      "2": [2, 2],
    });
    expect(Object.keys(result)).toEqual(["1", "2"]);
  });

  it("does not mutate the input array", () => {
    const items = [
      { type: "a", value: 1 },
      { type: "b", value: 2 },
    ];
    const copy = [...items];

    groupBy(items, (item) => item.type);

    expect(items).toEqual(copy);
  });
});
