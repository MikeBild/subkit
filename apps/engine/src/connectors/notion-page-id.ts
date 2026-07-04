// Notion page-id normaliser. A pasted Notion page link carries the id as a
// bare 32-hex run appended to the slug (`…/Some-Title-<32hex>`), while the
// REST API and the `page_id` recipe field expect a canonical 8-4-4-4-12
// UUID. Resolving the id at match-time mirrors `atlassian-tinyui.ts` and
// avoids the failure where an LLM-authored normalise transform 404s on a
// pasted URL (conversation 661e7ad1: `Could not extract 32-char page ID from
// https://app.notion.com/p/<Title>-<id>` → fetch_page http 404).

const DASHED_UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const BARE_HEX32 = /[0-9a-fA-F]{32}/g;

/** Hyphenate a 32-char hex string into the canonical 8-4-4-4-12 form. */
function toDashed(hex32: string): string {
  const h = hex32.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Extract a Notion page id from any of the forms a user might paste and
 * return it in canonical dashed UUID form, or `null` when no id is present.
 * Accepts: a full URL (`app.notion.com/p/<Title>-<32hex>`,
 * `www.notion.so/<ws>/<Title>-<32hex>?v=…`), a bare 32-hex id, and an
 * already-dashed UUID. Notion's API accepts both dashed and undashed; dashed
 * is the safest canonical form. Never throws.
 */
export function normalizeNotionPageId(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const text = input.trim();
  if (!text) return null;
  // A dashed UUID is already in canonical shape; a bare-hex scan would miss
  // it (the dashes break the 32-char run), so check this form first and take
  // the last occurrence (the page id trails the slug / precedes view params).
  const dashed = text.match(DASHED_UUID);
  if (dashed && dashed.length > 0) {
    return toDashed(dashed[dashed.length - 1]!.replace(/-/g, ""));
  }
  // Otherwise take the last bare 32-hex run — Notion appends `-<id>` to the
  // slug, so the trailing match is the page id.
  const bare = text.match(BARE_HEX32);
  if (bare && bare.length > 0) {
    return toDashed(bare[bare.length - 1]!);
  }
  return null;
}

/** Resource embedded in a Notion URL — the Notion analogue of
 *  `AtlassianCloudResource`, used by `match_connector_template_by_url` to
 *  hand the LLM a ready-to-use `page_id` instead of a probe round-trip. */
export type NotionResource = { kind: "notion_page"; page_id: string };

/**
 * Parse a Notion page URL and resolve its canonical page id. Returns `null`
 * for any non-`notion.{so,com}` host so callers can use this as a pre-flight
 * gate, and `null` when the host matches but no id is present.
 */
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
