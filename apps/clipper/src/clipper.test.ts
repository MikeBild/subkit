import { expect, test } from "bun:test";
import {
  attemptMatchesDocument,
  clearDraft,
  clipPath,
  createDraft,
  findDraft,
  listDrafts,
  loadDraft,
  loadSettings,
  markdown,
  normalizeEngineUrl,
  normalizeSourceUrl,
  parseInstallConfig,
  persistedCollectionSlug,
  saveDraft,
  saveSettings,
} from "./clipper.ts";

function draftStorage(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  return {
    get: async (keys?: string | string[]) => {
      if (!keys) return { ...values };
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        selected.flatMap((key) => (key in values ? [[key, values[key]]] : [])),
      );
    },
    set: async (next: Record<string, unknown>) => {
      Object.assign(values, next);
    },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    values,
  };
}

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

test("drafts are isolated by engine and immutable capture URL", async () => {
  const storage = draftStorage();
  const first = createDraft(
    { title: "First", sourceUrl: "https://example.test/page#one", capturedAt: "now" },
    "body",
    "https://engine.example",
  );
  const second = createDraft(
    { title: "Second", sourceUrl: "https://example.test/page", capturedAt: "later" },
    "body",
    "https://other.example",
  );
  await saveDraft(storage, first);
  await saveDraft(storage, second);
  expect((await listDrafts(storage)).map((draft) => draft.id)).toContain(first.id);
  expect(
    await findDraft(storage, "https://engine.example", "https://example.test/page#two"),
  ).toMatchObject({
    id: first.id,
    captureUrl: "https://example.test/page",
  });
  expect(await loadDraft(storage, second.id)).toMatchObject({ id: second.id });
});

test("legacy draft storage migrates without losing editable fields", async () => {
  const legacy = createDraft(
    { title: "Old", sourceUrl: "https://example.test/original", capturedAt: "then" },
    "body",
    "https://engine.example",
  );
  const { captureUrl: _, createdAt: __, updatedAt: ___, ...oldDraft } = legacy;
  const storage = draftStorage({ draft: oldDraft });
  expect(await loadDraft(storage, legacy.id)).toMatchObject({
    id: legacy.id,
    captureUrl: "https://example.test/original",
    metadata: { sourceUrl: "https://example.test/original" },
  });
  expect(storage.values.draft).toBeUndefined();
  expect(storage.values[`draft:${legacy.id}`]).toBeDefined();
});

test("discarding a draft does not remove other pages", async () => {
  const storage = draftStorage();
  const first = createDraft(
    { title: "First", sourceUrl: "https://example.test/first", capturedAt: "now" },
    "body",
    "https://engine.example",
  );
  const second = createDraft(
    { title: "Second", sourceUrl: "https://example.test/second", capturedAt: "now" },
    "body",
    "https://engine.example",
  );
  await saveDraft(storage, first);
  await saveDraft(storage, second);
  await clearDraft(storage, first.id);
  expect(await loadDraft(storage, first.id)).toBeUndefined();
  expect(await loadDraft(storage, second.id)).toMatchObject({ id: second.id });
});

test("a persisted knowledge collection slug wins over a generated slug", () => {
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
  expect(parseInstallConfig({ engine_url: null })).toBeUndefined();
});

test("the API key is kept in session storage and never written to local storage", async () => {
  const storage = { local: draftStorage(), session: draftStorage() };
  await saveSettings(storage, {
    engineUrl: "https://engine.example",
    apiKey: "sk_secret",
    language: "en",
  });
  expect(JSON.stringify(storage.local.values)).not.toContain("sk_secret");
  expect(storage.local.values).toEqual({
    settings: { engineUrl: "https://engine.example", language: "en" },
  });
  expect(await loadSettings(storage)).toEqual({
    engineUrl: "https://engine.example",
    apiKey: "sk_secret",
    language: "en",
  });
  await saveSettings(storage, { engineUrl: "https://engine.example", language: "en" });
  expect(storage.session.values).toEqual({});
  expect(await loadSettings(storage)).toEqual({
    engineUrl: "https://engine.example",
    language: "en",
  });
});

test("a key stored on the device by an earlier install moves to session storage", async () => {
  const storage = {
    local: draftStorage({ settings: { engineUrl: "https://engine.example", apiKey: "sk_old" } }),
    session: draftStorage(),
  };
  expect(await loadSettings(storage)).toEqual({
    engineUrl: "https://engine.example",
    apiKey: "sk_old",
  });
  expect(JSON.stringify(storage.local.values)).not.toContain("sk_old");
  expect(storage.session.values).toEqual({ apiKey: "sk_old" });
});

test("a key entered in this session wins over one left on the device", async () => {
  const storage = {
    local: draftStorage({ settings: { engineUrl: "https://engine.example", apiKey: "sk_old" } }),
    session: draftStorage({ apiKey: "sk_new" }),
  };
  expect((await loadSettings(storage)).apiKey).toBe("sk_new");
  expect(JSON.stringify(storage.local.values)).not.toContain("sk_old");
});
