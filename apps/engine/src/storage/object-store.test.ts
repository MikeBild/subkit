import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiskObjectStore } from "./object-store.ts";

const tmpRoots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "sk-object-store-test-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("LocalDiskObjectStore", () => {
  test("put then get round-trips bytes", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    const payload = Buffer.from("hello world");
    await store.put("a/b/file.bin", payload);
    const got = await store.get("a/b/file.bin");
    expect(got.toString("utf8")).toBe("hello world");
  });

  test("exists returns true after put, false after delete", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    await store.put("k", Buffer.from("x"));
    expect(await store.exists("k")).toBe(true);
    await store.delete("k");
    expect(await store.exists("k")).toBe(false);
  });

  test("delete is idempotent on a missing key", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    await store.delete("never-existed");
    expect(await store.exists("never-existed")).toBe(false);
  });

  test("rejects path-traversal keys", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    await expect(store.put("../escape.bin", Buffer.from("x"))).rejects.toThrow(/invalid key/);
  });

  test("rejects empty keys", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    await expect(store.put("", Buffer.from("x"))).rejects.toThrow(/invalid key/);
  });

  test("presignPut returns a local:// sentinel with expires_in", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    const presigned = await store.presignPut("knowledge/abc.pdf", 600);
    expect(presigned.url.startsWith("local://knowledge/abc.pdf")).toBe(true);
    expect(presigned.expires_in).toBeGreaterThanOrEqual(60);
    expect(presigned.expires_in).toBeLessThanOrEqual(3600);
  });

  test("presignPut TTL clamps to [60, max] from env", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    const tooSmall = await store.presignPut("k", 1);
    expect(tooSmall.expires_in).toBeGreaterThanOrEqual(60);
    const tooLarge = await store.presignPut("k", 99_999);
    expect(tooLarge.expires_in).toBeLessThanOrEqual(3600);
  });
});
