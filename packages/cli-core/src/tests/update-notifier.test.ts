import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifyIfUpdateAvailable } from "../update-notifier.ts";

// Each test uses a unique binary name so caches don't collide.
// The notifier creates its cache under ~/.{binaryName}/ so we use
// temp-prefixed names and clean up after.

let cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("notifyIfUpdateAvailable", () => {
  const originalWrite = process.stderr.write;
  let stderrOutput: string;

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  function captureStderr(): void {
    stderrOutput = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
  }

  test("writes banner to stderr when update available", async () => {
    captureStderr();
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          tag_name: "v99.0.0",
          prerelease: false,
          body: "",
          assets: [],
        }),
      )) as unknown as typeof fetch;

    // Use a unique name to avoid cache collisions
    const name = `notifier-test-banner-${Date.now()}`;
    notifyIfUpdateAvailable(name, fetchImpl);
    await new Promise((r) => setTimeout(r, 300));
    expect(stderrOutput).toContain("99.0.0");
    expect(stderrOutput).toContain(`${name} update`);
    // Clean up cache dir
    const { homedir } = await import("node:os");
    const cacheDir = join(homedir(), `.${name}`);
    cleanupDirs.push(cacheDir);
  });

  test("does nothing when no update available", async () => {
    captureStderr();
    // Return a version that is NOT newer than 0.0.0-dev (which parses as 0.0.0)
    // isNewer("0.0.0", "0.0.0") → false
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          tag_name: "v0.0.0",
          prerelease: false,
          body: "",
          assets: [],
        }),
      )) as unknown as typeof fetch;

    const name = `notifier-test-noop-${Date.now()}`;
    notifyIfUpdateAvailable(name, fetchImpl);
    await new Promise((r) => setTimeout(r, 300));
    expect(stderrOutput).toBe("");
    const { homedir } = await import("node:os");
    cleanupDirs.push(join(homedir(), `.${name}`));
  });

  test("swallows errors silently", async () => {
    captureStderr();
    const fetchImpl = (async () => {
      throw new Error("network failure");
    }) as unknown as typeof fetch;

    const name = `notifier-test-error-${Date.now()}`;
    notifyIfUpdateAvailable(name, fetchImpl);
    await new Promise((r) => setTimeout(r, 300));
    expect(stderrOutput).toBe("");
  });

  test("calls cleanupOldBinary without error", () => {
    // cleanupOldBinary is a no-op on non-Windows
    // Verify that notifyIfUpdateAvailable doesn't throw when calling it
    const fetchImpl = (async () =>
      new Response("", { status: 404 })) as unknown as typeof fetch;
    const name = `notifier-test-cleanup-${Date.now()}`;
    expect(() => notifyIfUpdateAvailable(name, fetchImpl)).not.toThrow();
  });
});
