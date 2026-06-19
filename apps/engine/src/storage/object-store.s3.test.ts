// S3ObjectStore — MinIO integration tests.
//
// Spins up a MinIO container via Docker (same pattern as
// connectors/tests/s3-driver.test.ts). Gated on `dockerAvailable()` so
// laptops without Docker exit 0 without failing. Tests the full
// ObjectStore surface against a real S3-compatible endpoint.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { S3Client } from "@bradenmacdonald/s3-lite-client";
import { S3ObjectStore } from "./object-store.ts";

interface MinioHandle {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  stop: () => Promise<void>;
}

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
      "minio/minio:latest",
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

let docker = false;
let minio: MinioHandle | null = null;
let store: S3ObjectStore | null = null;

beforeAll(async () => {
  docker = await dockerAvailable();
  if (!docker) {
    console.log("[object-store.s3.test] Docker unavailable — skipping S3 suite.");
    return;
  }
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
    accessKey: minio.accessKey,
    secretKey: minio.secretKey,
    bucket: BUCKET,
    pathStyle: true,
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

describe("S3ObjectStore (MinIO)", () => {
  test("put then get round-trips bytes", async () => {
    if (!docker || !store) return;
    const payload = Buffer.from("hello s3");
    await store.put("unit/a.bin", payload);
    const got = await store.get("unit/a.bin");
    expect(got.toString()).toBe("hello s3");
  });

  test("exists returns true after put, false for unknown key", async () => {
    if (!docker || !store) return;
    await store.put("unit/exists.bin", Buffer.from("x"));
    expect(await store.exists("unit/exists.bin")).toBe(true);
    expect(await store.exists("unit/never.bin")).toBe(false);
  });

  test("head returns size matching uploaded bytes", async () => {
    if (!docker || !store) return;
    const payload = Buffer.from("12345");
    await store.put("unit/head.bin", payload);
    const h = await store.head("unit/head.bin");
    expect(h).not.toBeNull();
    expect(h?.size).toBe(5);
  });

  test("head returns null for missing key", async () => {
    if (!docker || !store) return;
    expect(await store.head("unit/absent.bin")).toBeNull();
  });

  test("delete removes the key; exists returns false", async () => {
    if (!docker || !store) return;
    await store.put("unit/del.bin", Buffer.from("bye"));
    await store.delete("unit/del.bin");
    expect(await store.exists("unit/del.bin")).toBe(false);
  });

  test("copy replicates bytes to dst key", async () => {
    if (!docker || !store) return;
    await store.put("unit/src.bin", Buffer.from("copy me"));
    await store.copy("unit/src.bin", "unit/dst.bin");
    const got = await store.get("unit/dst.bin");
    expect(got.toString()).toBe("copy me");
    expect(await store.exists("unit/src.bin")).toBe(true);
  });

  test("openRead streams the same bytes as get()", async () => {
    if (!docker || !store) return;
    const payload = Buffer.from("streamed from s3");
    await store.put("unit/stream.bin", payload);
    const stream = await store.openRead("unit/stream.bin");
    const got = await drainStream(stream);
    expect(got.equals(payload)).toBe(true);
  });

  test("presignPut returns a real URL (not local:// sentinel)", async () => {
    if (!docker || !store) return;
    const p = await store.presignPut("unit/presign.bin", 300);
    expect(p.url.startsWith("http")).toBe(true);
    expect(p.expires_in).toBeGreaterThanOrEqual(60);
  });

  test("uploaded bytes via put match after get (byte equality)", async () => {
    if (!docker || !store) return;
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0xff, 0xfe]);
    await store.put("unit/bytes.bin", Buffer.from(bytes));
    const got = await store.get("unit/bytes.bin");
    expect([...got]).toEqual([...bytes]);
  });
});
