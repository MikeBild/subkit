#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  MULTIPART_PART_BYTES,
  type ObjectStoreConfig,
  S3ObjectStore,
} from "../apps/engine/src/storage/object-store.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function baseConfig(): ObjectStoreConfig {
  return {
    endpoint: required("OBJECT_STORAGE_ENDPOINT"),
    region: required("OBJECT_STORAGE_REGION"),
    bucket: required("OBJECT_STORAGE_BUCKET"),
    access_key_id: required("OBJECT_STORAGE_ACCESS_KEY_ID"),
    secret_access_key: required("OBJECT_STORAGE_SECRET_ACCESS_KEY"),
    ...(process.env.OBJECT_STORAGE_SESSION_TOKEN?.trim()
      ? { session_token: process.env.OBJECT_STORAGE_SESSION_TOKEN.trim() }
      : {}),
    force_path_style: booleanValue("OBJECT_STORAGE_PATH_STYLE", true),
  };
}

function rotatedConfig(base: ObjectStoreConfig): ObjectStoreConfig | null {
  const accessKey = process.env.OBJECT_STORAGE_ROTATED_ACCESS_KEY_ID?.trim();
  const secretKey = process.env.OBJECT_STORAGE_ROTATED_SECRET_ACCESS_KEY?.trim();
  if (!accessKey && !secretKey) return null;
  if (!accessKey || !secretKey) {
    throw new Error(
      "both OBJECT_STORAGE_ROTATED_ACCESS_KEY_ID and OBJECT_STORAGE_ROTATED_SECRET_ACCESS_KEY are required for the rotation probe",
    );
  }
  const { session_token: _oldSessionToken, ...baseWithoutSessionToken } = base;
  return {
    ...baseWithoutSessionToken,
    access_key_id: accessKey,
    secret_access_key: secretKey,
    ...(process.env.OBJECT_STORAGE_ROTATED_SESSION_TOKEN?.trim()
      ? {
          session_token: process.env.OBJECT_STORAGE_ROTATED_SESSION_TOKEN.trim(),
        }
      : {}),
  };
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function assertSha256(bytes: Uint8Array, expected: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error("application SHA-256 mismatch");
}

async function main(): Promise<void> {
  const config = baseConfig();
  const store = new S3ObjectStore(config);
  const prefix = `subkit-conformance/${randomUUID()}`;
  const cleanupKeys = new Set<string>();

  await store.headBucket();
  try {
    const smallKey = `${prefix}/small.bin`;
    const small = Buffer.from("subkit-s3-contract", "utf8");
    const smallSha = createHash("sha256").update(small).digest("hex");
    cleanupKeys.add(smallKey);
    await store.put(smallKey, small);
    assertSha256(await store.get(smallKey), smallSha);
    if ((await store.head(smallKey))?.size !== small.byteLength) {
      throw new Error("HeadObject returned an unexpected size");
    }
    const bounded = await drain(await store.openReadRange(smallKey, { start: 3, end: 8 }));
    if (!bounded.equals(small.subarray(3, 9))) {
      throw new Error("bounded Range read returned unexpected bytes");
    }
    const openEnded = await drain(await store.openReadRange(smallKey, { start: 7 }));
    if (!openEnded.equals(small.subarray(7))) {
      throw new Error("open-ended Range read returned unexpected bytes");
    }

    let mismatchDetected = false;
    try {
      assertSha256(small, "0".repeat(64));
    } catch (error) {
      mismatchDetected = error instanceof Error && error.message === "application SHA-256 mismatch";
    }
    if (!mismatchDetected) throw new Error("SHA-256 mismatch was not detected");

    const multipartKey = `${prefix}/multipart.bin`;
    const multipartSize = MULTIPART_PART_BYTES + 17;
    const expectedHash = createHash("sha256");
    cleanupKeys.add(multipartKey);
    async function* multipartBody(): AsyncIterable<Uint8Array> {
      const chunk = Buffer.alloc(8 * 1024 * 1024, 0x5a);
      let remaining = multipartSize;
      while (remaining > 0) {
        const count = Math.min(remaining, chunk.byteLength);
        const part = chunk.subarray(0, count);
        expectedHash.update(part);
        yield part;
        remaining -= count;
      }
    }
    await store.putStream(multipartKey, multipartBody(), multipartSize);
    if ((await store.head(multipartKey))?.size !== multipartSize) {
      throw new Error("multipart HeadObject returned an unexpected size");
    }
    const actualHash = createHash("sha256");
    for await (const chunk of await store.openRead(multipartKey)) {
      actualHash.update(chunk);
    }
    if (actualHash.digest("hex") !== expectedHash.digest("hex")) {
      throw new Error("multipart payload SHA-256 mismatch");
    }

    const abortKey = `${prefix}/abort-retry.bin`;
    cleanupKeys.add(abortKey);
    async function* interrupted(): AsyncIterable<Uint8Array> {
      yield Buffer.alloc(MULTIPART_PART_BYTES, 0x61);
      throw new Error("simulated source interruption");
    }
    let interruptionObserved = false;
    try {
      await store.putStream(abortKey, interrupted(), MULTIPART_PART_BYTES + 1);
    } catch (error) {
      interruptionObserved =
        error instanceof Error && error.message === "simulated source interruption";
    }
    if (!interruptionObserved || (await store.exists(abortKey))) {
      throw new Error("multipart abort did not leave the key retryable");
    }
    await store.put(abortKey, Buffer.from("retry-after-abort", "utf8"));

    const listed = await store.list(`${prefix}/`);
    if (!listed.some((item) => item.key === smallKey)) {
      throw new Error("ListObjectsV2 omitted the small object");
    }
    await store.delete(abortKey);
    cleanupKeys.delete(abortKey);
    if (await store.exists(abortKey)) {
      throw new Error("DeleteObject did not remove the retry object");
    }
    await store.deleteMany([smallKey, multipartKey]);
    cleanupKeys.delete(smallKey);
    cleanupKeys.delete(multipartKey);

    const rotated = rotatedConfig(config);
    if (rotated) {
      const rotatedStore = new S3ObjectStore(rotated);
      await rotatedStore.headBucket();
      const rotatedKey = `${prefix}/rotated-credentials.bin`;
      cleanupKeys.add(rotatedKey);
      await rotatedStore.put(rotatedKey, Buffer.from("rotated", "utf8"));
      if ((await rotatedStore.get(rotatedKey)).toString("utf8") !== "rotated") {
        throw new Error("rotated credentials did not round-trip an object");
      }
      await rotatedStore.delete(rotatedKey);
      cleanupKeys.delete(rotatedKey);
    }

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        endpoint: config.endpoint,
        bucket: config.bucket,
        credential_rotation_tested: rotated !== null,
      })}\n`,
    );
  } finally {
    if (cleanupKeys.size > 0) {
      await store.deleteMany([...cleanupKeys]).catch(() => {});
    }
  }
}

await main();
