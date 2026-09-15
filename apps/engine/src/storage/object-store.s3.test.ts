// S3ObjectStore — MinIO integration tests.
//
// Spins up a MinIO container via Docker (same pattern as
// connectors/tests/s3-driver.test.ts). Gated on `dockerAvailable()` so
// laptops without Docker exit 0 without failing. Tests the full
// ObjectStore surface against a real S3-compatible endpoint.

// A case that could not run must report SKIP, never PASS.
//
// LOCAL-SK-DOCKERFALL-ZAEHLT-ALS-BESTANDEN — the docker gate used to be a bare
// `return` in each test body. Under `SKIP_DOCKER=1` (how CI's test shards run)
// the run reported "20 pass, 0 skip" for this group while 15 of those cases had
// asserted nothing. A count that cannot distinguish "verified" from "never ran"
// is not evidence, and it is the number a release reads.
//
// The probe therefore happens once, at module scope, and the suites are gated
// with `describe.skipIf` / `test.skipIf` so bun counts them as skipped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { S3Client } from "@bradenmacdonald/s3-lite-client";
import { MULTIPART_PART_BYTES, S3ObjectStore } from "./object-store.ts";

interface MinioHandle {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  stop: () => Promise<void>;
}

const MINIO_IMAGE =
  "quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";

async function dockerAvailable(): Promise<boolean> {
  if (process.env.SKIP_DOCKER === "1") return false;
  const { spawnSync } = await import("node:child_process");
  try {
    const probe = spawnSync("docker", ["info"], { stdio: "ignore" });
    if (probe.status !== 0) return false;
  } catch {
    return false;
  }
  return true;
}

async function startMinio(): Promise<MinioHandle> {
  const accessKey = "minioadmin";
  const secretKey = "minioadmin";
  const name = `sk-s3-store-test-${Math.random().toString(36).slice(2, 8)}`; // allow-random: legacy; review before changing

  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "-p",
      "0:9000",
      "-e",
      `MINIO_ROOT_USER=${accessKey}`,
      "-e",
      `MINIO_ROOT_PASSWORD=${secretKey}`,
      MINIO_IMAGE,
      "server",
      "/data",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const containerId = (await new Response(proc.stdout).text()).trim();
  if (!containerId) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`Failed to start MinIO: ${errText}`);
  }

  const inspect = Bun.spawnSync([
    "docker",
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}',
    containerId,
  ]);
  const port = Number(new TextDecoder().decode(inspect.stdout).trim());
  if (!port) throw new Error("Failed to determine MinIO mapped port");

  // allow-wall-clock: this test exercises real-time polling or freshness windows.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/minio/health/live`);
      if (res.ok) break;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300)); // allow-wall-clock: S3 mock fixture warm-up before assertions
  }

  return {
    endpoint: `http://127.0.0.1:${port}`,
    accessKey,
    secretKey,
    stop: async () => {
      Bun.spawnSync(["docker", "rm", "-f", containerId]);
    },
  };
}

const BUCKET = `sk-objstore-test-${Math.random().toString(36).slice(2, 8)}`; // allow-random: legacy; review before changing

// Module scope, so the result is known before bun builds the test list.
const DOCKER = await dockerAvailable();
let minio: MinioHandle | null = null;
let store: S3ObjectStore | null = null;

beforeAll(async () => {
  if (!DOCKER) return;
  minio = await startMinio();
  const bootstrap = new S3Client({
    region: "us-east-1",
    endPoint: minio.endpoint,
    bucket: BUCKET,
    accessKey: minio.accessKey,
    secretKey: minio.secretKey,
    pathStyle: true,
  });
  try {
    await bootstrap.makeBucket(BUCKET);
  } catch {
    // may already exist
  }
  store = new S3ObjectStore({
    endpoint: minio.endpoint,
    region: "us-east-1",
    bucket: BUCKET,
    access_key_id: minio.accessKey,
    secret_access_key: minio.secretKey,
    force_path_style: true,
  });
});

afterAll(async () => {
  await minio?.stop();
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

describe.skipIf(!DOCKER)("S3ObjectStore (MinIO)", () => {
  test("HeadBucket validates the configured bucket", async () => {
    if (!store) throw new Error("MinIO bootstrap did not produce a store");
    await expect(store.headBucket()).resolves.toBeUndefined();
  });

  test("put then get round-trips bytes", async () => {
    if (!store) throw new Error("MinIO bootstrap did not produce a store");
    const payload = Buffer.from("hello s3");
    await store.put("unit/a.bin", payload);
    const got = await store.get("unit/a.bin");
    expect(got.toString()).toBe("hello s3");
  });

  test("exists returns true after put, false for unknown key", async () => {
    if (!store) throw new Error("MinIO bootstrap did not produce a store");
    await store.put("unit/exists.bin", Buffer.from("x"));
    expect(await store.exists("unit/exists.bin")).toBe(true);
    expect(await store.exists("unit/never.bin")).toBe(false);
  });

  test("head returns size matching uploaded bytes", async () => {
    if (!store) throw new Error("MinIO bootstrap did not produce a store");
    const payload = Buffer.from("12345");
    await store.put("unit/head.bin", payload);
    const h = await store.head("unit/head.bin");
    expect(h).not.toBeNull();
    expect(h?.size).toBe(5);
  });

  test("head returns null for missing key", async () => {
    if (!store) throw new Error("MinIO bootstrap did not produce a store");
    expect(await store.head("unit/absent.bin")).toBeNull();
  });

  test("delete removes the key; exists returns false", async () => {
    if (!store) throw new Error("MinIO bootstrap did not produce a store");
    await store.put("unit/del.bin", Buffer.from("bye"));
    await store.delete("unit/del.bin");
    expect(await store.exists("unit/del.bin")).toBe(false);
  });

  test("object keys are immutable", async () => {
    if (!store) throw new Error("MinIO bootstrap did not produce a store");
    await store.put("unit/immutable.bin", Buffer.from("first"));
    await expect(store.put("unit/immutable.bin", Buffer.from("second"))).rejects.toThrow(
      /immutable/,
    );
  });

  test("openRead streams the same bytes as get()", async () => {
    if (!store) throw new Error("MinIO bootstrap did not produce a store");
    const payload = Buffer.from("streamed from s3");
    await store.put("unit/stream.bin", payload);
    const stream = await store.openRead("unit/stream.bin");
    const got = await drainStream(stream);
    expect(got.equals(payload)).toBe(true);
  });

  test("range read, ListObjectsV2 and DeleteObjects use the common surface", async () => {
    if (!store) throw new Error("MinIO bootstrap did not produce a store");
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
    if (!store) throw new Error("MinIO bootstrap did not produce a store");
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
    if (!store) throw new Error("MinIO bootstrap did not produce a store");
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
    if (!store) throw new Error("MinIO bootstrap did not produce a store");
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0xff, 0xfe]);
    await store.put("unit/bytes.bin", Buffer.from(bytes));
    const got = await store.get("unit/bytes.bin");
    expect([...got]).toEqual([...bytes]);
  });
});
