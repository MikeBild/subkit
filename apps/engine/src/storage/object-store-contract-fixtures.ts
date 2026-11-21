import { describe, expect, test } from "bun:test";
import type { ObjectStore } from "./object-store.ts";

export async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

export async function drain(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

export interface ObjectStoreContractTarget {
  store(): ObjectStore;
  skip?: boolean;
}

export function objectStoreContract(name: string, target: ObjectStoreContractTarget): void {
  let sequence = 0;
  const scope = () => {
    sequence += 1;
    return `contract-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/${sequence}`;
  };

  describe.skipIf(target.skip === true)(`ObjectStore contract: ${name}`, () => {
    test("headBucket resolves for a ready store", async () => {
      await expect(target.store().headBucket()).resolves.toBeUndefined();
    });

    test("immutable put, head, get and exists", async () => {
      const store = target.store();
      const key = `${scope()}/object`;
      await store.put(key, Buffer.from("hello"));
      expect(await store.exists(key)).toBe(true);
      expect(await store.head(key)).toMatchObject({ size: 5 });
      expect((await store.get(key)).toString()).toBe("hello");
      await expect(store.put(key, Buffer.from("replace"))).rejects.toThrow(/immutable/);
      expect((await store.get(key)).toString()).toBe("hello");
    });

    test("binary bytes and a zero-byte object round-trip", async () => {
      const store = target.store();
      const base = scope();
      const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a]);
      await store.put(`${base}/bytes`, bytes);
      expect((await store.get(`${base}/bytes`)).equals(bytes)).toBe(true);
      await store.put(`${base}/empty`, Buffer.alloc(0));
      expect(await store.head(`${base}/empty`)).toMatchObject({ size: 0 });
      expect((await store.get(`${base}/empty`)).byteLength).toBe(0);
    });

    test("streaming put requires the exact declared Content-Length and leaves nothing on failure", async () => {
      const store = target.store();
      const base = scope();
      await store.putStream(`${base}/exact`, chunks("abc", "def"), 6);
      expect((await store.get(`${base}/exact`)).toString()).toBe("abcdef");
      await expect(store.putStream(`${base}/short`, chunks("abc"), 4)).rejects.toThrow(
        /did not match/,
      );
      await expect(store.putStream(`${base}/long`, chunks("abcde"), 4)).rejects.toThrow(/exceeded/);
      expect(await store.exists(`${base}/short`)).toBe(false);
      expect(await store.exists(`${base}/long`)).toBe(false);
    });

    test("a failing source leaves no object and the key can be written afterwards", async () => {
      const store = target.store();
      const key = `${scope()}/interrupted`;
      async function* interrupted(): AsyncIterable<Uint8Array> {
        yield Buffer.from("partial");
        throw new Error("simulated source interruption");
      }
      await expect(store.putStream(key, interrupted(), 20)).rejects.toThrow(
        "simulated source interruption",
      );
      expect(await store.exists(key)).toBe(false);
      await store.put(key, Buffer.from("retry"));
      expect((await store.get(key)).toString()).toBe("retry");
    });

    test("reads stream whole objects and inclusive ranges", async () => {
      const store = target.store();
      const key = `${scope()}/range`;
      await store.put(key, Buffer.from("abcdef"));
      expect((await drain(await store.openRead(key))).toString()).toBe("abcdef");
      expect((await drain(await store.openReadRange(key, { start: 1, end: 3 }))).toString()).toBe(
        "bcd",
      );
      expect((await drain(await store.openReadRange(key, { start: 3 }))).toString()).toBe("def");
      expect((await drain(await store.openReadRange(key, { start: 0, end: 0 }))).toString()).toBe(
        "a",
      );
    });

    test("list matches a raw key prefix and reports sizes", async () => {
      const store = target.store();
      const base = scope();
      await store.put(`${base}/x/1`, Buffer.from("1"));
      await store.put(`${base}/x/22`, Buffer.from("22"));
      await store.put(`${base}/y/3`, Buffer.from("333"));
      const listed = await store.list(`${base}/x/`);
      expect(listed.map((item) => [item.key, item.size]).sort()).toEqual([
        [`${base}/x/1`, 1],
        [`${base}/x/22`, 2],
      ]);
      expect(listed.every((item) => item.last_modified instanceof Date)).toBe(true);
      expect((await store.list(`${base}/x/2`)).map((item) => item.key)).toEqual([`${base}/x/22`]);
      expect((await store.list(`${base}/`)).map((item) => item.key).sort()).toEqual([
        `${base}/x/1`,
        `${base}/x/22`,
        `${base}/y/3`,
      ]);
      expect(await store.list(`${base}/none/`)).toEqual([]);
    });

    test("delete and deleteMany remove objects and ignore missing keys", async () => {
      const store = target.store();
      const base = scope();
      await store.put(`${base}/a`, Buffer.from("a"));
      await store.put(`${base}/b`, Buffer.from("b"));
      await store.put(`${base}/c`, Buffer.from("c"));
      await store.delete(`${base}/a`);
      await store.delete(`${base}/missing`);
      await store.deleteMany([`${base}/b`, `${base}/c`, `${base}/missing`]);
      await store.deleteMany([]);
      for (const key of ["a", "b", "c"]) expect(await store.exists(`${base}/${key}`)).toBe(false);
    });

    test("missing objects: head is null, get and openRead reject", async () => {
      const store = target.store();
      const key = `${scope()}/absent`;
      expect(await store.head(key)).toBeNull();
      expect(await store.exists(key)).toBe(false);
      await expect(store.get(key)).rejects.toThrow();
      await expect(
        (async () => {
          await drain(await store.openRead(key));
        })(),
      ).rejects.toThrow();
    });

    test("keys that differ only in case stay separate objects", async () => {
      const store = target.store();
      const base = scope();
      await store.put(`${base}/Report.json`, Buffer.from("upper"));
      await store.put(`${base}/report.json`, Buffer.from("lower"));
      expect((await store.get(`${base}/Report.json`)).toString()).toBe("upper");
      expect((await store.get(`${base}/report.json`)).toString()).toBe("lower");
    });
  });
}
