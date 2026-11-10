import { appendFileSync } from "node:fs";

export type OutputStream = "stdout" | "stderr";

export type BoundedOutputLog = Readonly<{
  append: (chunk: Buffer, stream?: OutputStream) => void;
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
  let stdoutTail: Buffer = Buffer.alloc(0);
  let stderrTail: Buffer = Buffer.alloc(0);
  const appendTail = (tail: Buffer, chunk: Buffer): Buffer => {
    if (chunk.byteLength >= tailBytes)
      return Buffer.from(chunk.subarray(chunk.byteLength - tailBytes));
    if (tail.byteLength + chunk.byteLength <= tailBytes) return Buffer.concat([tail, chunk]);
    return Buffer.concat([tail, chunk]).subarray(tail.byteLength + chunk.byteLength - tailBytes);
  };
  const append = (chunk: Buffer, stream: OutputStream = "stdout") => {
    totalBytes += chunk.byteLength;
    const remaining = maximumBytes - persistedBytes;
    if (remaining > 0) {
      const persisted = chunk.subarray(0, remaining);
      appendFileSync(path, persisted);
      persistedBytes += persisted.byteLength;
    }
    if (chunk.byteLength > remaining) truncated = true;
    if (stream === "stderr") stderrTail = appendTail(stderrTail, chunk);
    else stdoutTail = appendTail(stdoutTail, chunk);
  };
  return {
    append,
    snapshot: () => {
      const initialStderrBudget = Math.ceil(tailBytes / 2);
      const initialStderr = stderrTail.subarray(
        Math.max(0, stderrTail.byteLength - initialStderrBudget),
      );
      const stdoutBudget = tailBytes - initialStderr.byteLength;
      const retainedStdout = stdoutTail.subarray(Math.max(0, stdoutTail.byteLength - stdoutBudget));
      const stderrBudget = tailBytes - retainedStdout.byteLength;
      const retainedStderr = stderrTail.subarray(Math.max(0, stderrTail.byteLength - stderrBudget));
      return {
        totalBytes,
        persistedBytes,
        truncated,
        tail: Buffer.concat([retainedStdout, retainedStderr]),
      };
    },
  };
}
