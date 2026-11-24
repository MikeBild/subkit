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
  it("flags a result cut off at the page cap", async () => {
    const load = (size: number, seen: number[]) => async (offset: number) => {
      seen.push(offset);
      return {
        items: Array.from({ length: Math.min(100, size - offset) }, (_, i) => offset + i),
        total: size,
      };
    };
    const seen: number[] = [];
    const cut = await allPages(load(2001, seen));
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i * 100));
    expect(cut.items).toHaveLength(2000);
    expect(cut).toMatchObject({ total: 2001, truncated: true });
    const full = await allPages(load(2000, []));
    expect(full).toMatchObject({ total: 2000, truncated: false });
  });
});
