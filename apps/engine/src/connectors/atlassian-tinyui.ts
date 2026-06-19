// Atlassian Cloud URL parser. Tinyui shortlinks encode the page id as
// base64url of a little-endian uint32; decoding at match-time avoids
// probe round-trips in chat (session 0498925e: 3+ wasted calls).

/**
 * Decode an Atlassian tinyui shortlink suffix to its numeric page id,
 * or `null` if the input is not a valid base64url string of at least 4
 * decoded bytes. Never throws.
 */
export function decodeAtlassianTinyui(short: string): number | null {
  if (!short || typeof short !== "string") return null;
  // Regex rejects anything outside the base64url alphabet, so the
  // post-map string fed to Buffer.from is strictly valid base64.
  if (!/^[A-Za-z0-9_-]+$/.test(short)) return null;
  const padded = short + "=".repeat((4 - (short.length % 4)) % 4);
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length < 4) return null;
  return bytes.readUInt32LE(0);
}

/** Resource embedded in an Atlassian Cloud URL — used by
 *  `match_connector_template_by_url` to skip an API probe. */
export type AtlassianCloudResource =
  | { kind: "confluence_page"; page_id: number }
  | { kind: "confluence_tinyui"; short: string; page_id: number | null }
  | { kind: "jira_issue"; key: string };

/**
 * Parse a Confluence or Jira **Cloud** URL. Recognised paths:
 * `/wiki/x/<short>` (tinyui), `/wiki/spaces/.../pages/<id>` (direct
 * page), `/browse/<KEY-N>` (Jira issue). Atlassian Server / Data
 * Center is out of scope — those use different URL shapes. Returns
 * `null` for any non-`*.atlassian.{net,com}` host so callers can use
 * this as a pre-flight gate.
 */
export function parseAtlassianCloudResourceUrl(rawUrl: string): AtlassianCloudResource | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/\.atlassian\.(net|com)$/i.test(url.hostname)) return null;
  // /wiki/x/<short> — Confluence tinyui shortlink.
  const tinyuiMatch = url.pathname.match(/^\/wiki\/x\/([A-Za-z0-9_-]+)\/?$/);
  if (tinyuiMatch) {
    const short = tinyuiMatch[1]!;
    return {
      kind: "confluence_tinyui",
      short,
      page_id: decodeAtlassianTinyui(short),
    };
  }
  // /wiki/spaces/<space>/pages/<id>(/...)? — Confluence direct page link.
  const pageMatch = url.pathname.match(/^\/wiki\/spaces\/[^/]+\/pages\/(\d+)(?:\/|$)/);
  if (pageMatch) {
    const pageId = Number.parseInt(pageMatch[1]!, 10);
    if (Number.isFinite(pageId)) return { kind: "confluence_page", page_id: pageId };
  }
  // /browse/<KEY-N> — Jira issue.
  const issueMatch = url.pathname.match(/^\/browse\/([A-Z][A-Z0-9]+-\d+)\/?$/);
  if (issueMatch) {
    return { kind: "jira_issue", key: issueMatch[1]! };
  }
  return null;
}
