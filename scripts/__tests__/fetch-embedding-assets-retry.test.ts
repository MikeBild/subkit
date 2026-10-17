import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyRuntimeAsset,
  download,
  isTransient,
  matchesAsset,
} from "../fetch-embedding-assets.ts";

describe("isTransient", () => {
  test("the exact failure that broke a docker build", () => {
    expect(
      isTransient(
        new Error(
          "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        ),
      ),
    ).toBe(true);
  });

  test("server-side and connection-level failures retry", () => {
    for (const message of [
      "GET https://huggingface.co/x -> 503 Service Unavailable ",
      "GET https://huggingface.co/x -> 429 Too Many Requests ",
      "GET https://huggingface.co/x -> 408 Request Timeout ",
      "ECONNRESET",
      "EAI_AGAIN huggingface.co",
      "fetch failed",
    ]) {
      expect(isTransient(new Error(message))).toBe(true);
    }
  });

  test("a truncated body counts as transient", () => {
    expect(
      isTransient(
        new Error("GET https://huggingface.co/x returned 812 bytes (< 50000000 expected)"),
      ),
    ).toBe(true);
  });

  test("the server's verdict is not retried", () => {
    for (const message of [
      "GET https://huggingface.co/x -> 404 Not Found ",
      "GET https://huggingface.co/x -> 403 Forbidden ",
      "onnxruntime-web asset missing at /app/node_modules/... — run `bun install` before building",
    ]) {
      expect(isTransient(new Error(message))).toBe(false);
    }
  });
});

describe("download retry loop", () => {
  const directories: string[] = [];
  const tmp = () => {
    const directory = mkdtempSync(join(tmpdir(), "sk-embedding-"));
    directories.push(directory);
    return join(directory, "asset.bin");
  };
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  const expected = {
    bytes: 64,
    sha256: createHash("sha256").update(new Uint8Array(64)).digest("hex"),
  };
  const noSleep = async () => {};
  const body = (bytes: number) =>
    new Response(new Uint8Array(bytes), { status: 200, statusText: "OK" });

  test("a dropped socket is retried and the next attempt wins", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("The socket connection was closed unexpectedly.");
      return body(64);
    }) as unknown as typeof fetch;

    const dest = tmp();
    await download("https://example.test/a", dest, expected, flaky, noSleep);
    expect(calls).toBe(2);
    expect(Bun.file(dest).size).toBe(64);
    rmSync(dest, { force: true });
  });

  test("a 404 is not retried", async () => {
    let calls = 0;
    const gone = (async () => {
      calls += 1;
      return new Response("", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;

    await expect(
      download("https://example.test/b", tmp(), expected, gone, noSleep),
    ).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  test("a persistently broken connection gives up after four attempts", async () => {
    let calls = 0;
    const dead = (async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    await expect(
      download("https://example.test/c", tmp(), expected, dead, noSleep),
    ).rejects.toThrow(/ECONNRESET/);
    expect(calls).toBe(4);
  });

  test("a same-size checksum mismatch preserves an existing asset and does not retry", async () => {
    const dest = tmp();
    await Bun.write(dest, new Uint8Array(64));
    let calls = 0;
    const tampered = (async () => {
      calls++;
      return new Response(new Uint8Array(64).fill(1));
    }) as unknown as typeof fetch;
    await expect(
      download("https://example.test/tampered", dest, expected, tampered, noSleep),
    ).rejects.toThrow("checksum mismatch");
    expect(calls).toBe(1);
    expect(await matchesAsset(dest, expected)).toBe(true);
    expect(readdirSync(join(dest, ".."))).toEqual(["asset.bin"]);
  });

  test("cache validation rejects same-size changed content and extra bytes", async () => {
    const dest = tmp();
    expect(await matchesAsset(dest, expected)).toBe(false);
    await Bun.write(dest, new Uint8Array(64));
    expect(await matchesAsset(dest, expected)).toBe(true);
    await Bun.write(dest, new Uint8Array(64).fill(1));
    expect(await matchesAsset(dest, expected)).toBe(false);
    await Bun.write(dest, new Uint8Array(65));
    expect(await matchesAsset(dest, expected)).toBe(false);
  });

  test("runtime synchronization repairs a same-size corrupt destination", async () => {
    const source = tmp();
    const dest = tmp();
    await Bun.write(source, new Uint8Array(64));
    await Bun.write(dest, new Uint8Array(64).fill(1));
    await copyRuntimeAsset(source, dest, expected);
    expect(await matchesAsset(dest, expected)).toBe(true);
    expect(readdirSync(join(dest, ".."))).toEqual(["asset.bin"]);
  });

  test("an unexpected runtime package cannot overwrite an existing asset", async () => {
    const source = tmp();
    const dest = tmp();
    await Bun.write(source, new Uint8Array(64).fill(1));
    await Bun.write(dest, new Uint8Array(64));
    await expect(copyRuntimeAsset(source, dest, expected)).rejects.toThrow("checksum mismatch");
    expect(await matchesAsset(dest, expected)).toBe(true);
  });

  test("a truncated body retries before atomically installing the verified bytes", async () => {
    const dest = tmp();
    let calls = 0;
    const truncated = (async () => body(++calls === 1 ? 32 : 64)) as unknown as typeof fetch;
    await download("https://example.test/truncated", dest, expected, truncated, noSleep);
    expect(calls).toBe(2);
    expect(await matchesAsset(dest, expected)).toBe(true);
    expect(readdirSync(join(dest, ".."))).toEqual(["asset.bin"]);
  });
});
