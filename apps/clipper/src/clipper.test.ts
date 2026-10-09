import { expect, test } from "bun:test";
import {
  attemptMatchesDocument,
  clipPath,
  createDraft,
  markdown,
  normalizeEngineUrl,
  normalizeSourceUrl,
  parseInstallConfig,
  persistedCollectionSlug,
} from "./clipper.ts";

test("engine URLs permit HTTPS and local HTTP only", () => {
  expect(normalizeEngineUrl("https://engine.example/api/")).toBe("https://engine.example/api");
  expect(normalizeEngineUrl("http://localhost:3000")).toBe("http://localhost:3000");
  expect(() => normalizeEngineUrl("http://engine.example")).toThrow();
  expect(() => normalizeEngineUrl("https://key@engine.example")).toThrow();
  expect(() => normalizeEngineUrl("https://engine.example/?key=value")).toThrow();
});

test("clip paths are stable for a URL and ignore its fragment", async () => {
  const first = await clipPath("https://example.test/page?view=all#first");
  const second = await clipPath("https://example.test/page?view=all#second");
  expect(first).toBe(second);
  expect(first).toMatch(/^\/clips\/[a-f0-9]{12}\.md$/);
  expect(normalizeSourceUrl("https://example.test/page?q=x#part")).toBe(
    "https://example.test/page?q=x",
  );
});

test("attempt reconciliation requires byte-identical saved content", () => {
  const attempt = {
    operation: "append" as const,
    path: "/clips/a.md",
    content: "saved content",
  };
  expect(attemptMatchesDocument(attempt, [{ path: "/clips/a.md", content: "saved content" }])).toBe(
    true,
  );
  expect(attemptMatchesDocument(attempt, [{ path: "/clips/a.md", content: "changed" }])).toBe(
    false,
  );
});

test("copy paths and capture ownership remain stable across a retry", async () => {
  const first = await clipPath("https://example.test/page", "retry-token");
  const second = await clipPath("https://example.test/page", "retry-token");
  expect(first).toBe(second);
  expect(
    createDraft(
      { title: "Page", sourceUrl: "https://example.test/page", capturedAt: "now" },
      "body",
      "https://engine.example",
      42,
    ).captureTabId,
  ).toBe(42);
});

test("a collection creation retry keeps its original persisted slug", () => {
  expect(persistedCollectionSlug("saved-slug", undefined, "new-slug")).toBe("saved-slug");
  expect(persistedCollectionSlug(undefined, "attempt-slug", "new-slug")).toBe("attempt-slug");
});

test("Markdown uses the fixed source metadata envelope", () => {
  expect(
    markdown(
      {
        title: "A page",
        sourceUrl: "https://example.test/a#fragment",
        author: "Ada",
        publishedAt: "2025-01-02",
        capturedAt: "2025-02-03T04:05:06.000Z",
      },
      "Text",
    ),
  ).toBe(`---
title: "A page"
source_url: "https://example.test/a"
captured_at: "2025-02-03T04:05:06.000Z"
author: "Ada"
published_at: "2025-01-02"
---

Text
`);
});

test("install configuration accepts a valid address only", () => {
  expect(parseInstallConfig({ engine_url: "https://engine.example" })).toBe(
    "https://engine.example",
  );
  expect(parseInstallConfig({ engine_url: "http://engine.example" })).toBeUndefined();
  expect(parseInstallConfig({})).toBeUndefined();
});
