import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { S3Client } from "@bradenmacdonald/s3-lite-client";
import {
  dockerAvailable,
  type ObjectStoreFixture,
  startObjectStore,
} from "../tests/object-store-fixture.ts";
import { MULTIPART_PART_BYTES, S3ObjectStore } from "./object-store.ts";
import { objectStoreContract } from "./object-store-contract-fixtures.ts";

const BUCKET = `subkit-objstore-test-${Math.random().toString(36).slice(2, 8)}`; // allow-random: legacy; review before changing

const DOCKER = await dockerAvailable();
let objectStore: ObjectStoreFixture | null = null;
let store: S3ObjectStore | null = null;

beforeAll(async () => {
  if (!DOCKER) return;
  objectStore = await startObjectStore("subkit-s3-store-test");
  const bootstrap = new S3Client({
    region: "us-east-1",
    endPoint: objectStore.endpoint,
    bucket: BUCKET,
    accessKey: objectStore.accessKey,
    secretKey: objectStore.secretKey,
    pathStyle: true,
  });
  try {
    await bootstrap.makeBucket(BUCKET);
  } catch {}
  store = new S3ObjectStore({
    endpoint: objectStore.endpoint,
    region: "us-east-1",
    bucket: BUCKET,
    access_key_id: objectStore.accessKey,
    secret_access_key: objectStore.secretKey,
    force_path_style: true,
  });
}, 120_000);

afterAll(async () => {
  await objectStore?.stop();
}, 120_000);

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

describe.skipIf(!DOCKER)("S3ObjectStore (real S3 server)", () => {
  test("HeadBucket validates the configured bucket", async () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    await expect(store.headBucket()).resolves.toBeUndefined();
  });

  test("put then get round-trips bytes", async () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    const payload = Buffer.from("hello s3");
    await store.put("unit/a.bin", payload);
    const got = await store.get("unit/a.bin");
    expect(got.toString()).toBe("hello s3");
  });

  test("exists returns true after put, false for unknown key", async () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    await store.put("unit/exists.bin", Buffer.from("x"));
    expect(await store.exists("unit/exists.bin")).toBe(true);
    expect(await store.exists("unit/never.bin")).toBe(false);
  });

  test("head returns size matching uploaded bytes", async () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    const payload = Buffer.from("12345");
    await store.put("unit/head.bin", payload);
    const h = await store.head("unit/head.bin");
    expect(h).not.toBeNull();
    expect(h?.size).toBe(5);
  });

  test("head returns null for missing key", async () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    expect(await store.head("unit/absent.bin")).toBeNull();
  });

  test("delete removes the key; exists returns false", async () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    await store.put("unit/del.bin", Buffer.from("bye"));
    await store.delete("unit/del.bin");
    expect(await store.exists("unit/del.bin")).toBe(false);
  });

  test("object keys are immutable", async () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    await store.put("unit/immutable.bin", Buffer.from("first"));
    await expect(store.put("unit/immutable.bin", Buffer.from("second"))).rejects.toThrow(
      /immutable/,
    );
  });

  test("openRead streams the same bytes as get()", async () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    const payload = Buffer.from("streamed from s3");
    await store.put("unit/stream.bin", payload);
    const stream = await store.openRead("unit/stream.bin");
    const got = await drainStream(stream);
    expect(got.equals(payload)).toBe(true);
  });

  test("range read, ListObjectsV2 and DeleteObjects use the common surface", async () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    await store.put("contract/a.bin", Buffer.from("abcdef"));
    await store.put("contract/b.bin", Buffer.from("second"));
    expect(
      (
        await drainStream(await store.openReadRange("contract/a.bin", { start: 1, end: 3 }))
      ).toString(),
    ).toBe("bcd");
    expect(
      (await drainStream(await store.openReadRange("contract/a.bin", { start: 3 }))).toString(),
    ).toBe("def");
    expect((await store.list("contract/")).map((item) => item.key).sort()).toEqual([
      "contract/a.bin",
      "contract/b.bin",
    ]);
    await store.deleteMany(["contract/a.bin", "contract/b.bin"]);
    expect(await store.exists("contract/a.bin")).toBe(false);
    expect(await store.exists("contract/b.bin")).toBe(false);
  });

  test("known-length streams larger than 64 MiB use explicit multipart upload", async () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    const total = MULTIPART_PART_BYTES + 17;
    async function* payload(): AsyncIterable<Uint8Array> {
      const chunk = Buffer.alloc(8 * 1024 * 1024, 0x5a);
      let remaining = total;
      while (remaining > 0) {
        const count = Math.min(remaining, chunk.byteLength);
        yield chunk.subarray(0, count);
        remaining -= count;
      }
    }
    await store.putStream("contract/multipart.bin", payload(), total);
    expect(await store.head("contract/multipart.bin")).toMatchObject({
      size: total,
    });
    expect(
      (
        await drainStream(
          await store.openReadRange("contract/multipart.bin", {
            start: total - 17,
          }),
        )
      ).byteLength,
    ).toBe(17);
  }, 60_000);

  test("failed multipart uploads are aborted and the same immutable key can be retried", async () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    const key = "contract/abort-retry.bin";
    const total = MULTIPART_PART_BYTES + 1;
    async function* interrupted(): AsyncIterable<Uint8Array> {
      yield Buffer.alloc(MULTIPART_PART_BYTES, 0x61);
      throw new Error("simulated source interruption");
    }

    await expect(store.putStream(key, interrupted(), total)).rejects.toThrow(
      "simulated source interruption",
    );
    expect(await store.exists(key)).toBe(false);

    const retry = Buffer.from("retry-after-abort", "utf8");
    await store.put(key, retry);
    expect((await store.get(key)).equals(retry)).toBe(true);
  }, 60_000);

  test("uploaded bytes via put match after get (byte equality)", async () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0xff, 0xfe]);
    await store.put("unit/bytes.bin", Buffer.from(bytes));
    const got = await store.get("unit/bytes.bin");
    expect([...got]).toEqual([...bytes]);
  });
});

objectStoreContract("s3", {
  skip: !DOCKER,
  store: () => {
    if (!store) throw new Error("object store fixture did not produce a store");
    return store;
  },
});
