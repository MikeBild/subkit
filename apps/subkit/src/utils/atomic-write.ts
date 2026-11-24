import type { FileHandle } from "node:fs/promises";
import { open, rename, rm } from "node:fs/promises";

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function writeStreamAtomically(
  stream: ReadableStream<Uint8Array>,
  outPath: string,
  options: { expectedBytes?: number } = {},
): Promise<number> {
  const tempPath = `${outPath}.part-${process.pid}`;
  let handle: FileHandle;
  try {
    handle = await open(tempPath, "w");
  } catch (err) {
    await stream.cancel().catch(() => {});
    throw new Error(`cannot write ${outPath}: ${reasonOf(err)}`, { cause: err });
  }
  let writtenBytes = 0;
  try {
    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          await handle.write(value);
          writtenBytes += value.byteLength;
        }
      }
    } finally {
      await handle.close();
    }
    const { expectedBytes } = options;
    if (expectedBytes !== undefined && writtenBytes !== expectedBytes) {
      throw new Error(`transfer ended early: received ${writtenBytes} of ${expectedBytes} bytes`);
    }
    await rename(tempPath, outPath);
    return writtenBytes;
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw new Error(
      `download to ${outPath} failed, previous file left unchanged: ${reasonOf(err)}`,
      { cause: err },
    );
  }
}
