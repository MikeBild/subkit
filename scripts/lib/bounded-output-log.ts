import { appendFileSync } from "node:fs";

export type BoundedOutputLog = Readonly<{
  append: (chunk: Buffer) => void;
  snapshot: () => Readonly<{
    totalBytes: number;
    persistedBytes: number;
    truncated: boolean;
    tail: Buffer;
  }>;
}>;

export function createBoundedOutputLog(
  path: string,
  maximumBytes = 16 * 1024 * 1024,
  tailBytes = 64 * 1024,
): BoundedOutputLog {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error("maximumBytes must be a positive safe integer");
  if (!Number.isSafeInteger(tailBytes) || tailBytes < 1)
    throw new Error("tailBytes must be a positive safe integer");
  let totalBytes = 0;
  let persistedBytes = 0;
  let truncated = false;
  let tail = Buffer.alloc(0);
  const append = (chunk: Buffer) => {
    totalBytes += chunk.byteLength;
    const remaining = maximumBytes - persistedBytes;
    if (remaining > 0) {
      const persisted = chunk.subarray(0, remaining);
      appendFileSync(path, persisted);
      persistedBytes += persisted.byteLength;
    }
    if (chunk.byteLength > remaining) truncated = true;
    if (chunk.byteLength >= tailBytes) {
      tail = Buffer.from(chunk.subarray(chunk.byteLength - tailBytes));
    } else if (tail.byteLength + chunk.byteLength > tailBytes) {
      tail = Buffer.concat([tail, chunk]).subarray(tail.byteLength + chunk.byteLength - tailBytes);
    } else {
      tail = Buffer.concat([tail, chunk]);
    }
  };
  return {
    append,
    snapshot: () => ({ totalBytes, persistedBytes, truncated, tail: Buffer.from(tail) }),
  };
}
