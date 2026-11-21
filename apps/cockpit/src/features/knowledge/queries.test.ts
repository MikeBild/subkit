import { describe, expect, it } from "bun:test";
import { allPages } from "./queries";

describe("allPages", () => {
  it("loads pages until the total is reached", async () => {
    const data = Array.from({ length: 250 }, (_, i) => i);
    const seen: number[] = [];
    const r = await allPages(async (offset) => {
      seen.push(offset);
      return { items: data.slice(offset, offset + 100), total: data.length };
    });
    expect(r.items).toHaveLength(250);
    expect(seen).toEqual([0, 100, 200]);
  });
  it("stops on an empty page", async () => {
    const r = await allPages(async (offset) => ({ items: offset ? [] : [1], total: 5 }));
    expect(r.items).toEqual([1]);
  });
});
