import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSelfUpdate } from "../self-update.ts";

let tmpDir: string;
let stdoutOutput: string;
const originalWrite = process.stdout.write;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engine-self-update-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  process.stdout.write = originalWrite;
});

function captureStdout(): void {
  stdoutOutput = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutOutput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
}

function makeFetchImpl(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as unknown as typeof fetch;
}

describe("engine runSelfUpdate", () => {
  test("prints 'already at latest' when no update available", async () => {
    captureStdout();
    const fetchImpl = makeFetchImpl(
      () =>
        new Response(
          JSON.stringify({
            tag_name: "v0.0.0",
            prerelease: false,
            body: "",
            assets: [],
          }),
        ),
    );

    await runSelfUpdate(fetchImpl);
    expect(stdoutOutput).toContain("already at latest version");
  });

  test("prints version transition message when update found", async () => {
    captureStdout();
    // Return a newer version but with no matching asset so performUpdate will fail
    // We're testing the output message, not the actual download
    const fetchImpl = makeFetchImpl(
      () =>
        new Response(
          JSON.stringify({
            tag_name: "v99.0.0",
            prerelease: false,
            body: "notes",
            assets: [
              { name: "SHA256SUMS", browser_download_url: "https://example.com/SHA256SUMS" },
            ],
          }),
        ),
    );

    try {
      await runSelfUpdate(fetchImpl);
    } catch {
      // performUpdate throws because no matching binary asset — expected
    }
    expect(stdoutOutput).toContain("checking for updates");
    expect(stdoutOutput).toContain("99.0.0");
  });

  test("uses force=true (bypasses cache)", async () => {
    captureStdout();
    let fetchCalled = false;
    const fetchImpl = makeFetchImpl(() => {
      fetchCalled = true;
      return new Response(
        JSON.stringify({
          tag_name: "v0.0.0",
          prerelease: false,
          body: "",
          assets: [],
        }),
      );
    });

    await runSelfUpdate(fetchImpl);
    expect(fetchCalled).toBe(true);
  });

  test("does not import env.ts (no DATABASE_URL required)", async () => {
    // This test verifies that runSelfUpdate can be called without
    // any engine environment variables being set.
    // If it imported env.ts eagerly, it would throw on missing DATABASE_URL.
    captureStdout();
    const fetchImpl = makeFetchImpl(
      () =>
        new Response(
          JSON.stringify({ tag_name: "v0.0.0", prerelease: false, body: "", assets: [] }),
        ),
    );
    // Should not throw
    await runSelfUpdate(fetchImpl);
    expect(stdoutOutput).toContain("already at latest version");
  });

  test("handles fetch errors gracefully", async () => {
    captureStdout();
    const fetchImpl = makeFetchImpl(() => {
      throw new Error("network error");
    });

    // checkForUpdate catches fetch errors and returns null
    await runSelfUpdate(fetchImpl);
    expect(stdoutOutput).toContain("already at latest version");
  });
});
