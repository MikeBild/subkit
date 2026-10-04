const DASHED_UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const BARE_HEX32 = /[0-9a-fA-F]{32}/g;

function toDashed(hex32: string): string {
  const h = hex32.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function normalizeNotionPageId(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const text = input.trim();
  if (!text) return null;
  const dashed = text.match(DASHED_UUID);
  if (dashed && dashed.length > 0) {
    return toDashed(dashed[dashed.length - 1]!.replace(/-/g, ""));
  }
  const bare = text.match(BARE_HEX32);
  if (bare && bare.length > 0) {
    return toDashed(bare[bare.length - 1]!);
  }
  return null;
}

export type NotionResource = { kind: "notion_page"; page_id: string };

export function parseNotionResourceUrl(rawUrl: string): NotionResource | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)notion\.(so|com)$/i.test(url.hostname)) return null;
  const page_id = normalizeNotionPageId(url.pathname + url.search);
  return page_id ? { kind: "notion_page", page_id } : null;
}
