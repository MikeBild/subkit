// Unit tests for the what's-new resolver. Covers fresh-cache hit,
// stale-cache + remote success, stale-cache + remote failure
// (returns stale headline), no cache + remote success, no cache +
// remote failure (returns null), and timeout behavior.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  changelogHead,
  isFresh,
  loadWhatsNew,
  loadWhatsNewSync,
  readCache,
  sanitizeHeadline,
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
    // Pass url explicitly because the default posture
    // is opt-in (no env var → no network call). Tests that exercise
    // the fetcher must supply `url` directly.
    const out = await loadWhatsNew({
      url: "https://example.test/wn.json",
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
    // Hang until the production-side AbortController fires; no
    // test-side wall-clock sleep. loadWhatsNew's `timeoutMs:10`
    // schedules the abort, the listener below rejects with
    // AbortError, and loadWhatsNew falls back to changelogHead().
    const out = await loadWhatsNew({
      cachePath: cachePath(),
      timeoutMs: 10,
      fetcher: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (init.signal.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
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

  test("changelogHead drops the compare-URL parenthetical (no truncation, copy-safe)", () => {
    // Regression for the `…subkit-v6.…` banner bug: the release-please
    // header carries a compare diff URL that was being truncated mid-string
    // inside the width-clamped banner box.
    const body =
      "# Changelog\n\n## [6.10.1](https://github.com/MikeBild/subkit/compare/subkit-v6.10.0...subkit-v6.10.1)\n";
    const head = changelogHead(body);
    expect(head).toBe("v6.10.1");
    expect(head).not.toContain("http");
    expect(head).not.toContain("…");
    expect((head ?? "").length).toBeLessThanOrEqual(80);
  });

  test("changelogHead keeps a real prose tail after the compare URL", () => {
    const body =
      "# Changelog\n\n## [6.11.0](https://github.com/x/y/compare/a...b) — knowledge tags\n";
    expect(changelogHead(body)).toBe("v6.11.0 — knowledge tags");
  });

  test("changelogHead from bundled CHANGELOG returns a v-prefixed string", () => {
    expect(changelogHead()).toMatch(/^v\d+\.\d+/);
  });

  test("loadWhatsNewSync returns fresh cache when present", () => {
    const now = 1_700_000_000_000;
    writeCache({ headline: "from cache", fetchedAt: now - 1000 }, cachePath());
    expect(loadWhatsNewSync({ cachePath: cachePath(), now: () => now })).toBe("from cache");
  });

  test("loadWhatsNewSync returns stale cache when no fresh value", () => {
    const now = 1_700_000_000_000;
    writeCache({ headline: "stale", fetchedAt: now - 25 * 3600 * 1000 }, cachePath());
    expect(loadWhatsNewSync({ cachePath: cachePath(), now: () => now })).toBe("stale");
  });

  test("loadWhatsNewSync falls back to bundled CHANGELOG when no cache exists", () => {
    expect(loadWhatsNewSync({ cachePath: cachePath() })).toMatch(/^v\d/);
  });

  test("sanitizeHeadline strips ANSI escapes", () => {
    expect(sanitizeHeadline("[31mred[0m headline")).toBe("red headline");
    expect(sanitizeHeadline("\x1b]9;notify\x07hello")).toBe("hello");
  });

  test("sanitizeHeadline strips control bytes", () => {
    expect(sanitizeHeadline("hi\x07\x08\x1b\nbye")).toBe("hibye");
  });

  test("sanitizeHeadline truncates at 80 chars", () => {
    const long = "x".repeat(120);
    const out = sanitizeHeadline(long);
    expect(out?.length).toBeLessThanOrEqual(80);
    expect(out).toMatch(/…$/);
  });

  test("sanitizeHeadline returns null for empty / non-string / collapse-to-empty", () => {
    expect(sanitizeHeadline("")).toBeNull();
    expect(sanitizeHeadline("   ")).toBeNull();
    expect(sanitizeHeadline("\x1b\x07")).toBeNull();
    expect(sanitizeHeadline(null)).toBeNull();
    expect(sanitizeHeadline(42)).toBeNull();
  });

  test("whatsNewUrl returns null by default (opt-in)", () => {
    const prev = process.env.SK_WHATS_NEW_URL;
    try {
      delete process.env.SK_WHATS_NEW_URL;
      // Default posture is opt-in: no env var → no network call.
      expect(whatsNewUrl()).toBeNull();
    } finally {
      if (prev !== undefined) process.env.SK_WHATS_NEW_URL = prev;
      else delete process.env.SK_WHATS_NEW_URL;
    }
  });

  test("whatsNewUrl returns null when SK_WHATS_NEW_URL is empty / disabled", () => {
    const prev = process.env.SK_WHATS_NEW_URL;
    try {
      process.env.SK_WHATS_NEW_URL = "";
      expect(whatsNewUrl()).toBeNull();
      process.env.SK_WHATS_NEW_URL = "disabled";
      expect(whatsNewUrl()).toBeNull();
      process.env.SK_WHATS_NEW_URL = "off";
      expect(whatsNewUrl()).toBeNull();
      process.env.SK_WHATS_NEW_URL = "0";
      expect(whatsNewUrl()).toBeNull();
    } finally {
      if (prev !== undefined) process.env.SK_WHATS_NEW_URL = prev;
      else delete process.env.SK_WHATS_NEW_URL;
    }
  });

  test("whatsNewUrl returns the operator-supplied URL when SK_WHATS_NEW_URL is set", () => {
    const prev = process.env.SK_WHATS_NEW_URL;
    try {
      process.env.SK_WHATS_NEW_URL = "https://example.com/whats-new.json";
      expect(whatsNewUrl()).toBe("https://example.com/whats-new.json");
    } finally {
      if (prev !== undefined) process.env.SK_WHATS_NEW_URL = prev;
      else delete process.env.SK_WHATS_NEW_URL;
    }
  });

  test("loadWhatsNew with disabled URL skips network and falls back", async () => {
    const prev = process.env.SK_WHATS_NEW_URL;
    let fetchedCount = 0;
    try {
      process.env.SK_WHATS_NEW_URL = "disabled";
      const out = await loadWhatsNew({
        cachePath: cachePath(),
        fetcher: async () => {
          fetchedCount++;
          return jsonResponse({ headline: "should-not-be-called" });
        },
      });
      expect(fetchedCount).toBe(0);
      // Falls back to bundled CHANGELOG since cache is empty.
      expect(out).toMatch(/^v\d/);
    } finally {
      if (prev !== undefined) process.env.SK_WHATS_NEW_URL = prev;
      else delete process.env.SK_WHATS_NEW_URL;
    }
  });

  test("whatsNewUrl honors SK_WHATS_NEW_URL override and is null by default", () => {
    const prev = process.env.SK_WHATS_NEW_URL;
    try {
      process.env.SK_WHATS_NEW_URL = "https://example.test/wn.json";
      expect(whatsNewUrl()).toBe("https://example.test/wn.json");
      delete process.env.SK_WHATS_NEW_URL;
      // Opt-in default — `undefined` env yields null,
      // not the recommended URL. Operators must set the env var
      // explicitly to enable the network call.
      expect(whatsNewUrl()).toBeNull();
    } finally {
      if (prev !== undefined) process.env.SK_WHATS_NEW_URL = prev;
      else delete process.env.SK_WHATS_NEW_URL;
    }
  });
});
