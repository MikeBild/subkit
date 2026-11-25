import { createHash } from "node:crypto";

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>)
    hash.update(chunk);
  return hash.digest("hex");
}
