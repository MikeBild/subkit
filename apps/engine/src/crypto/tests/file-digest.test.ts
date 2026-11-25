import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256OfFile } from "../file-digest.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("sha256OfFile hashes the whole file like a one-shot digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "file-digest-"));
  dirs.push(dir);
  const content = new Uint8Array(300_000).map((_, index) => index % 251);
  const path = join(dir, "blob.bin");
  await Bun.write(path, content);
  expect(await sha256OfFile(path)).toBe(createHash("sha256").update(content).digest("hex"));
});
