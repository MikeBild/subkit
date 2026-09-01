import { describe, expect, test } from "bun:test";
import { MemoryObjectStore } from "./object-store.ts";

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts).toString("utf8");
}

describe("ObjectStore contract", () => {
  test("immutable put, head, get and exists", async () => {
    const store = new MemoryObjectStore();
    await store.put("tenant/object", Buffer.from("hello"));
    expect(await store.exists("tenant/object")).toBe(true);
    expect(await store.head("tenant/object")).toEqual({ size: 5 });
    expect((await store.get("tenant/object")).toString()).toBe("hello");
    await expect(store.put("tenant/object", Buffer.from("replace"))).rejects.toThrow(/immutable/);
  });

  test("streaming put requires the exact declared Content-Length", async () => {
    const store = new MemoryObjectStore();
    await store.putStream("tenant/exact", chunks("abc", "def"), 6);
    expect((await store.get("tenant/exact")).toString()).toBe("abcdef");
    await expect(store.putStream("tenant/short", chunks("abc"), 4)).rejects.toThrow(
      /did not match/,
    );
    await expect(store.putStream("tenant/long", chunks("abcde"), 4)).rejects.toThrow(/exceeded/);
  });

  test("range, list and batch delete follow the common surface", async () => {
    const store = new MemoryObjectStore();
    await store.put("tenant/a", Buffer.from("abcdef"));
    await store.put("tenant/b", Buffer.from("second"));
    await store.put("other/c", Buffer.from("ignored"));
    expect(await drain(await store.openReadRange("tenant/a", { start: 1, end: 3 }))).toBe("bcd");
    expect((await store.list("tenant/")).map((item) => item.key).sort()).toEqual([
      "tenant/a",
      "tenant/b",
    ]);
    await store.deleteMany(["tenant/a", "tenant/b"]);
    expect(await store.exists("tenant/a")).toBe(false);
    expect(await store.exists("tenant/b")).toBe(false);
  });
});
