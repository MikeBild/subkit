// Provider-neutral S3 object store used by every binary payload path.
//
// The runtime contract deliberately excludes local disk, CopyObject,
// presigned URLs, ACLs, tagging, object locking, bucket versioning and S3
// checksum headers. Object keys are immutable; PostgreSQL owns active
// pointers and application SHA-256 metadata.

import { createHash } from "node:crypto";

import { S3Client } from "@bradenmacdonald/s3-lite-client";

import { getConfig, isConfigLoaded } from "../config/loader.ts";

export const MULTIPART_PART_BYTES = 64 * 1024 * 1024;

export interface ObjectHead {
  size: number;
  etag?: string;
}

export interface ListedObject extends ObjectHead {
  key: string;
  last_modified: Date;
}

export interface ObjectStore {
  headBucket(): Promise<void>;
  put(key: string, body: Buffer | Uint8Array): Promise<void>;
  putStream(key: string, body: AsyncIterable<Uint8Array>, contentLength: number): Promise<void>;
  get(key: string): Promise<Buffer>;
  openRead(key: string): Promise<AsyncIterable<Uint8Array>>;
  openReadRange(
    key: string,
    range: { start?: number; end?: number },
  ): Promise<AsyncIterable<Uint8Array>>;
  head(key: string): Promise<ObjectHead | null>;
  list(prefix: string): Promise<ListedObject[]>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export interface ObjectStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
  force_path_style: boolean;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function xmlValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]!) : null;
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}

async function collectKnownLength(
  body: AsyncIterable<Uint8Array>,
  expected: number,
): Promise<Uint8Array> {
  const output = Buffer.allocUnsafe(expected);
  let offset = 0;
  for await (const chunk of body) {
    if (offset + chunk.byteLength > expected) {
      throw new Error(`object upload exceeded declared Content-Length ${expected}`);
    }
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== expected) {
    throw new Error(
      `object upload length ${offset} did not match declared Content-Length ${expected}`,
    );
  }
  return output;
}

async function* fixedParts(
  body: AsyncIterable<Uint8Array>,
  expected: number,
): AsyncIterable<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let buffered = 0;
  let consumed = 0;

  const take = (length: number): Uint8Array => {
    const part = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const first = chunks[0]!;
      const count = Math.min(first.byteLength, length - written);
      part.set(first.subarray(0, count), written);
      written += count;
      buffered -= count;
      if (count === first.byteLength) chunks.shift();
      else chunks[0] = first.subarray(count);
    }
    return part;
  };

  for await (const chunk of body) {
    consumed += chunk.byteLength;
    if (consumed > expected) {
      throw new Error(`object upload exceeded declared Content-Length ${expected}`);
    }
    if (chunk.byteLength > 0) {
      chunks.push(chunk);
      buffered += chunk.byteLength;
    }
    while (buffered >= MULTIPART_PART_BYTES) yield take(MULTIPART_PART_BYTES);
  }
  if (consumed !== expected) {
    throw new Error(
      `object upload length ${consumed} did not match declared Content-Length ${expected}`,
    );
  }
  if (buffered > 0) yield take(buffered);
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ObjectStoreConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endPoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKey: config.access_key_id,
      secretKey: config.secret_access_key,
      ...(config.session_token ? { sessionToken: config.session_token } : {}),
      pathStyle: config.force_path_style,
    });
  }

  async headBucket(): Promise<void> {
    await this.client.makeRequest({
      method: "HEAD",
      bucketName: this.bucket,
      objectName: "",
      statusCode: 200,
    });
  }

  private async assertImmutableKey(key: string): Promise<void> {
    if (await this.exists(key))
      throw new Error(`object key already exists and is immutable: ${key}`);
  }

  private async putSingle(key: string, body: Uint8Array): Promise<void> {
    await this.client.makeRequest({
      method: "PUT",
      bucketName: this.bucket,
      objectName: key,
      headers: new Headers({ "If-None-Match": "*" }),
      payload: Uint8Array.from(body),
      statusCode: 200,
    });
  }

  async put(key: string, body: Buffer | Uint8Array): Promise<void> {
    const bytes = body instanceof Buffer ? new Uint8Array(body) : body;
    await this.putStream(
      key,
      (async function* () {
        yield bytes;
      })(),
      bytes.byteLength,
    );
  }

  private async createMultipart(key: string): Promise<string> {
    const response = await this.client.makeRequest({
      method: "POST",
      bucketName: this.bucket,
      objectName: key,
      query: "uploads",
      returnBody: true,
      statusCode: 200,
    });
    const uploadId = xmlValue(await response.text(), "UploadId");
    if (!uploadId) throw new Error("S3 CreateMultipartUpload response omitted UploadId");
    return uploadId;
  }

  private async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<string> {
    const response = await this.client.makeRequest({
      method: "PUT",
      bucketName: this.bucket,
      objectName: key,
      query: { uploadId, partNumber: String(partNumber) },
      payload: Uint8Array.from(bytes),
      statusCode: 200,
    });
    const etag = response.headers.get("etag");
    if (!etag) throw new Error(`S3 UploadPart ${partNumber} response omitted ETag`);
    return etag;
  }

  private async listParts(key: string, uploadId: string): Promise<number[]> {
    const response = await this.client.makeRequest({
      method: "GET",
      bucketName: this.bucket,
      objectName: key,
      query: { uploadId },
      returnBody: true,
      statusCode: 200,
    });
    const xml = await response.text();
    return [...xml.matchAll(/<PartNumber>([1-9][0-9]*)<\/PartNumber>/g)].map((match) =>
      Number(match[1]),
    );
  }

  private async completeMultipart(
    key: string,
    uploadId: string,
    parts: Array<{ number: number; etag: string }>,
  ): Promise<void> {
    const xml =
      "<CompleteMultipartUpload>" +
      parts
        .map(
          (part) =>
            `<Part><PartNumber>${part.number}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
        )
        .join("") +
      "</CompleteMultipartUpload>";
    const response = await this.client.makeRequest({
      method: "POST",
      bucketName: this.bucket,
      objectName: key,
      query: { uploadId },
      payload: xml,
      returnBody: true,
      statusCode: 200,
    });
    const responseXml = await response.text();
    if (/<Error>[\s\S]*<\/Error>/.test(responseXml)) {
      throw new Error(
        `S3 CompleteMultipartUpload failed: ${xmlValue(responseXml, "Message") ?? "unknown error"}`,
      );
    }
  }

  private async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.client.makeRequest({
      method: "DELETE",
      bucketName: this.bucket,
      objectName: key,
      query: { uploadId },
      statusCode: 204,
    });
  }

  async putStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentLength: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new Error("object upload requires a known non-negative Content-Length");
    }
    await this.assertImmutableKey(key);
    if (contentLength <= MULTIPART_PART_BYTES) {
      await this.putSingle(key, await collectKnownLength(body, contentLength));
      return;
    }

    const uploadId = await this.createMultipart(key);
    const uploaded: Array<{ number: number; etag: string }> = [];
    try {
      let number = 0;
      for await (const part of fixedParts(body, contentLength)) {
        number += 1;
        uploaded.push({
          number,
          etag: await this.uploadPart(key, uploadId, number, part),
        });
      }
      const listed = await this.listParts(key, uploadId);
      if (
        listed.length !== uploaded.length ||
        uploaded.some((part, index) => listed[index] !== part.number)
      ) {
        throw new Error("S3 ListParts did not match uploaded multipart sequence");
      }
      await this.completeMultipart(key, uploadId, uploaded);
    } catch (error) {
      await this.abortMultipart(key, uploadId).catch(() => {});
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.getObject(key);
    return Buffer.from(await response.arrayBuffer());
  }

  async openRead(key: string): Promise<AsyncIterable<Uint8Array>> {
    return this.openReadRange(key, {});
  }

  async openReadRange(
    key: string,
    range: { start?: number; end?: number },
  ): Promise<AsyncIterable<Uint8Array>> {
    const ranged = range.start !== undefined || range.end !== undefined;
    const response = ranged
      ? await this.client.getPartialObject(key, {
          offset: range.start ?? 0,
          length: range.end === undefined ? 0 : range.end - (range.start ?? 0) + 1,
        })
      : await this.client.getObject(key);
    return response.body ?? (async function* () {})();
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const status = await this.client.statObject(key);
      return {
        size: status.size,
        ...(status.etag ? { etag: status.etag } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<ListedObject[]> {
    const items: ListedObject[] = [];
    for await (const item of this.client.listObjects({ prefix })) {
      if (item.type !== "Object") continue;
      items.push({
        key: item.key,
        size: item.size,
        ...(item.etag ? { etag: item.etag } : {}),
        last_modified: item.lastModified,
      });
    }
    return items;
  }

  async delete(key: string): Promise<void> {
    await this.client.deleteObject(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      const batch = keys.slice(offset, offset + 1_000);
      const xml =
        "<Delete>" +
        batch.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join("") +
        "</Delete>";
      const contentMd5 = createHash("md5").update(xml).digest("base64");
      const response = await this.client.makeRequest({
        method: "POST",
        bucketName: this.bucket,
        objectName: "",
        query: "delete",
        headers: new Headers({
          "Content-MD5": contentMd5,
          "Content-Type": "application/xml",
        }),
        payload: xml,
        returnBody: true,
        statusCode: 200,
      });
      const responseXml = await response.text();
      if (/<Error>[\s\S]*<\/Error>/.test(responseXml)) {
        throw new Error(
          `S3 DeleteObjects failed: ${xmlValue(responseXml, "Message") ?? "unknown error"}`,
        );
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }
}

/** In-memory test double; never selected in a production process. */
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  async headBucket(): Promise<void> {}

  async put(key: string, body: Buffer | Uint8Array): Promise<void> {
    if (this.objects.has(key))
      throw new Error(`object key already exists and is immutable: ${key}`);
    this.objects.set(key, new Uint8Array(body));
  }

  async putStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentLength: number,
  ): Promise<void> {
    await this.put(key, await collectKnownLength(body, contentLength));
  }

  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) throw new Error(`object not found: ${key}`);
    return Buffer.from(value);
  }

  async openRead(key: string): Promise<AsyncIterable<Uint8Array>> {
    return this.openReadRange(key, {});
  }

  async openReadRange(
    key: string,
    range: { start?: number; end?: number },
  ): Promise<AsyncIterable<Uint8Array>> {
    const value = await this.get(key);
    const start = range.start ?? 0;
    const end = range.end === undefined ? value.byteLength : range.end + 1;
    const chunk = value.subarray(start, end);
    return (async function* () {
      yield chunk;
    })();
  }

  async head(key: string): Promise<ObjectHead | null> {
    const value = this.objects.get(key);
    return value ? { size: value.byteLength } : null;
  }

  async list(prefix: string): Promise<ListedObject[]> {
    return [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({
        key,
        size: value.byteLength,
        last_modified: new Date(0),
      }));
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

function readObjectStoreConfig(): ObjectStoreConfig {
  const config = getConfig().storage.object_store;
  if (
    !config.endpoint ||
    !config.region ||
    !config.bucket ||
    !config.access_key_id ||
    !config.secret_access_key
  ) {
    throw new Error(
      "object storage is not configured; endpoint, region, bucket, access_key_id and secret_access_key are required",
    );
  }
  return {
    ...config,
    ...(config.session_token ? { session_token: config.session_token } : {}),
  };
}

let cached: ObjectStore | null = null;

export function getObjectStore(): ObjectStore {
  if (cached) return cached;
  if (
    process.env.NODE_ENV === "test" ||
    (!isConfigLoaded() && process.env.NODE_ENV !== "production")
  ) {
    cached = new MemoryObjectStore();
    return cached;
  }
  cached = new S3ObjectStore(readObjectStoreConfig());
  return cached;
}

export async function preflightObjectStoreConfig(
  storage: ReturnType<typeof getConfig>["storage"],
): Promise<void> {
  if (process.env.NODE_ENV === "test" && !storage.object_store.endpoint) return;
  const config = storage.object_store;
  if (
    !config.endpoint ||
    !config.region ||
    !config.bucket ||
    !config.access_key_id ||
    !config.secret_access_key
  ) {
    throw new Error(
      "object storage bootstrap requires endpoint, region, bucket, access_key_id and secret_access_key",
    );
  }
  const store = new S3ObjectStore({
    ...config,
    ...(config.session_token ? { session_token: config.session_token } : {}),
  });
  await store.headBucket();
}

export function resetObjectStoreForRuntimeConfig(): void {
  cached = null;
}

export function setObjectStoreForTesting(store: ObjectStore | null): void {
  cached = store;
}
