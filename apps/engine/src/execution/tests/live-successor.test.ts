import { describe, expect, test } from "bun:test";
import { resolveLiveSuccessor } from "../live-successor.ts";

describe("resolveLiveSuccessor", () => {
  test("a replacement that commits between resolving and reading still finds the successor", async () => {
    const supersededBy = new Map<string, string>();
    const live = new Set(["A"]);
    const resolve = async (id: string) => {
      let current = id;
      while (supersededBy.has(current)) current = supersededBy.get(current) as string;
      return current;
    };
    const read = async (id: string) => {
      if (id === "A") {
        live.delete("A");
        live.add("B");
        supersededBy.set("A", "B");
      }
      return live.has(id) ? { id } : undefined;
    };
    expect(await resolveLiveSuccessor("A", resolve, read)).toEqual({ id: "B" });
  });

  test("a revoked authority without a successor stays unavailable", async () => {
    const reads: string[] = [];
    const result = await resolveLiveSuccessor(
      "A",
      async (id) => id,
      async (id) => {
        reads.push(id);
        return undefined;
      },
    );
    expect(result).toBeUndefined();
    expect(reads).toEqual(["A"]);
  });

  test("a live authority is read once", async () => {
    const reads: string[] = [];
    const result = await resolveLiveSuccessor(
      "A",
      async () => "B",
      async (id) => {
        reads.push(id);
        return { id };
      },
    );
    expect(result).toEqual({ id: "B" });
    expect(reads).toEqual(["B"]);
  });
});
