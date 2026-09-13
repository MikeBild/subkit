import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { getTestNow } from "../../../../apps/engine/src/test-helpers/determinism/clock.ts";
import { notifyIfUpdateAvailable } from "../update-notifier.ts";

const TEST_NOW_MS = getTestNow();

// Each test uses a unique binary name so caches don't collide.
// The notifier creates its cache under ~/.{binaryName}/ so we use
// temp-prefixed names and clean up after.

const cleanupDirs: string[] = [];

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
    const name = `notifier-test-banner-${TEST_NOW_MS}`;
    notifyIfUpdateAvailable(name, fetchImpl);
    await new Promise((r) => setTimeout(r, 300)); // allow-wall-clock: update-notifier debounce window across cache reads
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

    const name = `notifier-test-noop-${TEST_NOW_MS}`;
    notifyIfUpdateAvailable(name, fetchImpl);
    await new Promise((r) => setTimeout(r, 300)); // allow-wall-clock: update-notifier debounce window across cache reads
    expect(stderrOutput).toBe("");
    const { homedir } = await import("node:os");
    cleanupDirs.push(join(homedir(), `.${name}`));
  });

  test("swallows errors silently", async () => {
    captureStderr();
    const fetchImpl = (async () => {
      throw new Error("network failure");
    }) as unknown as typeof fetch;

    const name = `notifier-test-error-${TEST_NOW_MS}`;
    notifyIfUpdateAvailable(name, fetchImpl);
    await new Promise((r) => setTimeout(r, 300)); // allow-wall-clock: update-notifier debounce window across cache reads
    expect(stderrOutput).toBe("");
  });

  test("calls cleanupOldBinary without error", () => {
    // cleanupOldBinary is a no-op on non-Windows
    // Verify that notifyIfUpdateAvailable doesn't throw when calling it
    const fetchImpl = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const name = `notifier-test-cleanup-${TEST_NOW_MS}`;
    expect(() => notifyIfUpdateAvailable(name, fetchImpl)).not.toThrow();
  });
});
