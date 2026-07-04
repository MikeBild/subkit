// LocalDiskObjectStore — full surface tests.
//
// Extends the baseline object-store.test.ts with the remaining surface:
// head, copy, openRead (streamed), presignPut sentinel, and the full
// path-traversal fuzz matrix.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiskObjectStore } from "./object-store.ts";

const tmpRoots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "sk-object-store-local-test-"));
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

async function drainStream(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

describe("LocalDiskObjectStore — full surface", () => {
  test("put then get round-trips bytes", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    await store.put("dir/file.bin", Buffer.from("hello"));
    const got = await store.get("dir/file.bin");
    expect(got.toString()).toBe("hello");
  });

  test("exists returns true after put, false before", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    expect(await store.exists("x")).toBe(false);
    await store.put("x", Buffer.from("data"));
    expect(await store.exists("x")).toBe(true);
  });

  test("delete removes the file; exists returns false afterwards", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    await store.put("del.bin", Buffer.from("bye"));
    await store.delete("del.bin");
    expect(await store.exists("del.bin")).toBe(false);
  });

  test("delete is idempotent on a missing key", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    await store.delete("never-existed");
    expect(await store.exists("never-existed")).toBe(false);
  });

  test("head returns size after put", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    const payload = Buffer.from("abc");
    await store.put("head-test.bin", payload);
    const h = await store.head("head-test.bin");
    expect(h).not.toBeNull();
    expect(h?.size).toBe(3);
  });

  test("head returns null for missing key", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    expect(await store.head("missing.bin")).toBeNull();
  });

  test("copy replicates bytes to dst key", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    const payload = Buffer.from("original");
    await store.put("src.bin", payload);
    await store.copy("src.bin", "dst.bin");
    const got = await store.get("dst.bin");
    expect(got.toString()).toBe("original");
  });

  test("copy leaves src intact", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    await store.put("s.bin", Buffer.from("keep"));
    await store.copy("s.bin", "d.bin");
    expect(await store.exists("s.bin")).toBe(true);
  });

  test("openRead streams the same bytes as get()", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    const payload = Buffer.from("streamed content");
    await store.put("stream.bin", payload);
    const stream = await store.openRead("stream.bin");
    const got = await drainStream(stream);
    expect(got.toString()).toBe("streamed content");
  });

  test("presignPut returns local:// sentinel containing the key", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    const p = await store.presignPut("tenant/2024/01/01/uuid", 300);
    expect(p.url.startsWith("local://tenant/2024/01/01/uuid")).toBe(true);
    expect(typeof p.headers["content-type"]).toBe("string");
    expect(p.expires_in).toBeGreaterThanOrEqual(60);
    expect(p.expires_in).toBeLessThanOrEqual(3600);
  });

  // Path-traversal fuzz matrix
  test("rejects key with double-dot (..)", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    await expect(store.put("..", Buffer.from("x"))).rejects.toThrow();
  });

  test("rejects key containing ../../etc/passwd", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    await expect(store.put("../../etc/passwd", Buffer.from("x"))).rejects.toThrow();
  });

  test("rejects key with embedded .. segment", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    await expect(store.put("a/../b", Buffer.from("x"))).rejects.toThrow();
  });

  test("rejects empty key", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    await expect(store.put("", Buffer.from("x"))).rejects.toThrow();
  });

  test("rejects subkit-file:// scheme key with traversal", async () => {
    const store = new LocalDiskObjectStore(makeRoot());
    // The key is extracted from the URI by the caller before reaching the
    // store. This test verifies the store itself rejects any key that
    // contains '..', regardless of how it arrived.
    await expect(store.put("subkit-file://x/../y", Buffer.from("x"))).rejects.toThrow();
  });

  test("rejects an absolute key that is a sibling-prefix of the root (#58)", async () => {
    // No '..' here — the attack is an absolute path whose string prefix
    // matches the root. resolvePath honours the absolute key, and the old
    // `startsWith(root)` check wrongly admitted "<root>-evil/...". The
    // separator-anchored containment must reject it.
    const root = makeRoot();
    const store = new LocalDiskObjectStore(root);
    await expect(store.put(`${root}-evil/escape`, Buffer.from("x"))).rejects.toThrow(/escapes/);
  });
});
