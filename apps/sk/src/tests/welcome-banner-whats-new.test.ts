// Unit tests for the what's-new resolver. Covers fresh-cache hit,
// stale-cache + remote success, stale-cache + remote failure
// (returns stale headline), no cache + remote success, no cache +
// remote failure (returns null), and timeout behavior.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changelogHead,
  isFresh,
  loadWhatsNew,
  readCache,
  whatsNewUrl,
  writeCache,
} from "../repl/welcome-banner/whats-new.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sk-whats-new-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function cachePath(): string {
  return join(tmp, "whats-new-cache.json");
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("whats-new — read/write/isFresh", () => {
  test("readCache returns null when file missing", () => {
    expect(readCache(cachePath())).toBeNull();
  });

  test("readCache returns null on malformed JSON", () => {
    Bun.write(cachePath(), "not json").then(() => {
      expect(readCache(cachePath())).toBeNull();
    });
  });

  test("writeCache + readCache round-trip", () => {
    writeCache({ headline: "v4.3 ships M1", fetchedAt: 1234 }, cachePath());
    expect(existsSync(cachePath())).toBe(true);
    expect(readCache(cachePath())).toEqual({ headline: "v4.3 ships M1", fetchedAt: 1234 });
  });

  test("isFresh true within 24h, false after", () => {
    const now = 1_700_000_000_000;
    expect(isFresh({ headline: "x", fetchedAt: now - 1000 }, now)).toBe(true);
    expect(isFresh({ headline: "x", fetchedAt: now - 23 * 3600 * 1000 }, now)).toBe(true);
    expect(isFresh({ headline: "x", fetchedAt: now - 25 * 3600 * 1000 }, now)).toBe(false);
  });
});

describe("loadWhatsNew", () => {
  test("returns fresh-cached headline without fetching", async () => {
    const now = 1_700_000_000_000;
    writeCache({ headline: "from cache", fetchedAt: now - 1000 }, cachePath());
    let fetched = false;
    const out = await loadWhatsNew({
      cachePath: cachePath(),
      now: () => now,
      fetcher: async () => {
        fetched = true;
        return jsonResponse({ headline: "from remote" });
      },
    });
    expect(out).toBe("from cache");
    expect(fetched).toBe(false);
  });

  test("fetches remote when cache stale and updates cache", async () => {
    const now = 1_700_000_000_000;
    writeCache({ headline: "stale", fetchedAt: now - 25 * 3600 * 1000 }, cachePath());
    const out = await loadWhatsNew({
      cachePath: cachePath(),
      now: () => now,
      fetcher: async () => jsonResponse({ headline: "fresh remote" }),
    });
    expect(out).toBe("fresh remote");
    const cached = readCache(cachePath());
    expect(cached?.headline).toBe("fresh remote");
    expect(cached?.fetchedAt).toBe(now);
  });

  test("returns stale-cached headline when remote fetch fails", async () => {
    const now = 1_700_000_000_000;
    writeCache({ headline: "stale", fetchedAt: now - 25 * 3600 * 1000 }, cachePath());
    const out = await loadWhatsNew({
      cachePath: cachePath(),
      now: () => now,
      fetcher: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(out).toBe("stale");
  });

  test("falls back to bundled CHANGELOG head when no cache and remote fails", async () => {
    const out = await loadWhatsNew({
      cachePath: cachePath(),
      fetcher: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    // Bundled CHANGELOG always has at least one `## [version]` header,
    // so the fallback returns a string starting with `v`.
    expect(out).toMatch(/^v\d/);
  });

  test("falls back to bundled CHANGELOG head when remote returns non-OK status", async () => {
    const out = await loadWhatsNew({
      cachePath: cachePath(),
      fetcher: async () => new Response("nope", { status: 500 }),
    });
    expect(out).toMatch(/^v\d/);
  });

  test("returns cached headline when remote returns malformed body", async () => {
    const now = 1_700_000_000_000;
    writeCache({ headline: "kept", fetchedAt: now - 25 * 3600 * 1000 }, cachePath());
    const out = await loadWhatsNew({
      cachePath: cachePath(),
      now: () => now,
      fetcher: async () => jsonResponse({ wrong: "shape" }),
    });
    expect(out).toBe("kept");
  });

  test("aborts on timeout and falls back to bundled CHANGELOG head", async () => {
    const out = await loadWhatsNew({
      cachePath: cachePath(),
      timeoutMs: 10,
      fetcher: async (_url, init) => {
        await new Promise((r) => setTimeout(r, 100));
        if (init.signal.aborted) throw new DOMException("aborted", "AbortError");
        return jsonResponse({ headline: "should-not-arrive" });
      },
    });
    expect(out).toMatch(/^v\d/);
  });

  test("changelogHead extracts the latest version line from a CHANGELOG body", () => {
    const body = `# Changelog

## [4.5.0] (unreleased)

### Added
- thing
- another thing

## [4.4.0] (2026-04-30)
`;
    expect(changelogHead(body)).toBe("v4.5.0 (unreleased)");
  });

  test("changelogHead returns null when no version header exists", () => {
    expect(changelogHead("# just a header\n\nno versions here")).toBeNull();
  });

  test("changelogHead from bundled CHANGELOG returns a v-prefixed string", () => {
    expect(changelogHead()).toMatch(/^v\d+\.\d+/);
  });

  test("whatsNewUrl honors SK_WHATS_NEW_URL override", () => {
    const prev = process.env.SK_WHATS_NEW_URL;
    try {
      process.env.SK_WHATS_NEW_URL = "https://example.test/wn.json";
      expect(whatsNewUrl()).toBe("https://example.test/wn.json");
      delete process.env.SK_WHATS_NEW_URL;
      expect(whatsNewUrl()).toBe("https://updates.subkit.dev/whats-new.json");
    } finally {
      if (prev !== undefined) process.env.SK_WHATS_NEW_URL = prev;
      else delete process.env.SK_WHATS_NEW_URL;
    }
  });
});
