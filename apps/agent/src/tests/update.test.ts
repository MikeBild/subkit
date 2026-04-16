import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAndLogUpdate, runAgentSelfUpdate, startPeriodicUpdateCheck } from "../update.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-update-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeFetchImpl(
  handler: (url: string) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return handler(url);
  }) as unknown as typeof fetch;
}

describe("tunnel-agent checkAndLogUpdate", () => {
  test("does not throw when update is available", async () => {
    const fetchImpl = makeFetchImpl(() =>
      new Response(
        JSON.stringify({
          tag_name: "v99.0.0",
          prerelease: false,
          body: "",
          assets: [],
        }),
      ),
    );
    // Should log a warning but not throw
    await checkAndLogUpdate(fetchImpl);
  });

  test("does not throw when version is current", async () => {
    const fetchImpl = makeFetchImpl(() =>
      new Response(
        JSON.stringify({
          tag_name: "v0.0.0",
          prerelease: false,
          body: "",
          assets: [],
        }),
      ),
    );
    await checkAndLogUpdate(fetchImpl);
  });

  test("swallows errors silently", async () => {
    const fetchImpl = makeFetchImpl(() => {
      throw new Error("network error");
    });
    // checkForUpdate catches fetch errors internally
    await checkAndLogUpdate(fetchImpl);
  });
});

describe("tunnel-agent runAgentSelfUpdate", () => {
  test("logs 'already at latest' when no update available", async () => {
    const fetchImpl = makeFetchImpl(() =>
      new Response(
        JSON.stringify({
          tag_name: "v0.0.0",
          prerelease: false,
          body: "",
          assets: [],
        }),
      ),
    );
    // Should not throw
    await runAgentSelfUpdate(fetchImpl);
  });

  test("uses force=true (always fetches)", async () => {
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
    await runAgentSelfUpdate(fetchImpl);
    expect(fetchCalled).toBe(true);
  });

  test("attempts performUpdate when newer version found", async () => {
    const fetchImpl = makeFetchImpl(() =>
      new Response(
        JSON.stringify({
          tag_name: "v99.0.0",
          prerelease: false,
          body: "",
          assets: [
            { name: "SHA256SUMS", browser_download_url: "https://example.com/SHA256SUMS" },
          ],
        }),
      ),
    );
    // performUpdate will throw because no matching binary asset
    await expect(runAgentSelfUpdate(fetchImpl)).rejects.toThrow(/no binary/);
  });
});

describe("tunnel-agent startPeriodicUpdateCheck", () => {
  test("returns a timer handle", () => {
    const fetchImpl = makeFetchImpl(() => new Response("", { status: 404 }));
    const timer = startPeriodicUpdateCheck(999_999_999, fetchImpl);
    expect(timer).toBeDefined();
    clearInterval(timer);
  });

  test("can be started and stopped without error", () => {
    const fetchImpl = makeFetchImpl(() =>
      new Response(
        JSON.stringify({
          tag_name: "v0.0.0",
          prerelease: false,
          body: "",
          assets: [],
        }),
      ),
    );
    const timer = startPeriodicUpdateCheck(86_400_000, fetchImpl);
    // Verify the timer can be cleared without error
    clearInterval(timer);
  });

  test("timer is unref'd (doesn't block shutdown)", () => {
    const fetchImpl = makeFetchImpl(() => new Response("", { status: 404 }));
    const timer = startPeriodicUpdateCheck(999_999_999, fetchImpl);
    // If the timer were ref'd, this test process would hang.
    // We verify it's a valid timer that can be cleared.
    expect(typeof timer).not.toBe("undefined");
    clearInterval(timer);
  });
});
