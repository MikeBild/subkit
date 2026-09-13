// Notion page-id normaliser tests. The conversation-661e7ad1 regression
// fixture (app.notion.com/p/SubKit-Strategie-<id> → dashed id) is the
// canonical example; the rest covers the URL/id forms a user might paste.

import { describe, expect, it } from "bun:test";

import { normalizeNotionPageId, parseNotionResourceUrl } from "./notion-page-id.ts";

const RAW = "386492c68914803da988f2c7aacd3749";
const DASHED = "386492c6-8914-803d-a988-f2c7aacd3749";

describe("normalizeNotionPageId", () => {
  it("resolves the conversation-661e7ad1 app.notion.com/p URL", () => {
    expect(normalizeNotionPageId(`https://app.notion.com/p/SubKit-Strategie-${RAW}`)).toBe(DASHED);
  });

  it("resolves a www.notion.so workspace URL with a view query", () => {
    expect(normalizeNotionPageId(`https://www.notion.so/acme/Some-Title-${RAW}?v=abc&pvs=4`)).toBe(
      DASHED,
    );
  });

  it("normalises a bare 32-hex id", () => {
    expect(normalizeNotionPageId(RAW)).toBe(DASHED);
  });

  it("passes through an already-dashed UUID (lowercased)", () => {
    expect(normalizeNotionPageId(DASHED)).toBe(DASHED);
    expect(normalizeNotionPageId(DASHED.toUpperCase())).toBe(DASHED);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeNotionPageId(`  ${RAW}  `)).toBe(DASHED);
  });

  it("takes the trailing id when the slug also contains hex-looking text", () => {
    // The id always trails the slug, so the last 32-hex run wins.
    expect(normalizeNotionPageId(`https://notion.so/deadbeef-Title-${RAW}`)).toBe(DASHED);
  });

  it("returns null when no id is present", () => {
    expect(normalizeNotionPageId("https://www.notion.so/my-integrations")).toBe(null);
    expect(normalizeNotionPageId("not an id")).toBe(null);
  });

  it("returns null on empty / non-string input", () => {
    expect(normalizeNotionPageId("")).toBe(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- defensive null handling
    expect(normalizeNotionPageId(null as any)).toBe(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- defensive null handling
    expect(normalizeNotionPageId(undefined as any)).toBe(null);
  });
});

describe("parseNotionResourceUrl", () => {
  it("resolves an app.notion.com page URL to a notion_page resource", () => {
    expect(parseNotionResourceUrl(`https://app.notion.com/p/SubKit-Strategie-${RAW}`)).toEqual({
      kind: "notion_page",
      page_id: DASHED,
    });
  });

  it("resolves a www.notion.so page URL", () => {
    expect(parseNotionResourceUrl(`https://www.notion.so/Title-${RAW}`)).toEqual({
      kind: "notion_page",
      page_id: DASHED,
    });
  });

  it("returns null for non-Notion hosts", () => {
    expect(parseNotionResourceUrl(`https://example.com/p/Title-${RAW}`)).toBe(null);
  });

  it("returns null for a Notion host with no page id", () => {
    expect(parseNotionResourceUrl("https://www.notion.so/my-integrations")).toBe(null);
  });

  it("returns null for malformed URLs", () => {
    expect(parseNotionResourceUrl("not a url")).toBe(null);
    expect(parseNotionResourceUrl("")).toBe(null);
  });
});
