import { afterAll, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyDownloadedUpdate } from "./update-verify.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("a manifest signed by any key other than the release key is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "update-verify-"));
  dirs.push(dir);
  const installer = join(dir, "subkit-desktop-13.1.0-win-x64.exe");
  const content = Buffer.from("installer-bytes");
  await writeFile(installer, content);
  const manifest = `${createHash("sha256").update(content).digest("hex")}  subkit-desktop-13.1.0-win-x64.exe\n`;
  const forger = generateKeyPairSync("ed25519");
  const forged = sign(null, Buffer.from(manifest), forger.privateKey);
  const requested: string[] = [];
  const fetcher = (async (url: string) => {
    requested.push(url);
    return new Response(url.endsWith(".sig") ? forged : manifest);
  }) as unknown as typeof fetch;
  expect(await verifyDownloadedUpdate("13.1.0", installer, fetcher)).toEqual({
    ok: false,
    reason: "signature_invalid",
  });
  expect(requested.sort()).toEqual([
    "https://github.com/MikeBild/subkit/releases/download/v13.1.0/SHA256SUMS-desktop",
    "https://github.com/MikeBild/subkit/releases/download/v13.1.0/SHA256SUMS-desktop.sig",
  ]);
});

test("a failed download of the manifest surfaces its HTTP status", async () => {
  const fetcher = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  await expect(verifyDownloadedUpdate("13.1.0", "/missing.exe", fetcher)).rejects.toThrow(
    "HTTP 404",
  );
});
