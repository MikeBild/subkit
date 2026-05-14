// Atlassian tinyui shortlinks (e.g. /wiki/x/y4ozBQ) encode the numeric
// Confluence page id as base64url of a little-endian uint32 — a
// documented Atlassian convention. Without decoding, the LLM has to
// probe the API by trial-and-error to find the page id, which in
// session 0498925e cost 3+ extra round-trips before the right page
// resolved (87263947 — "[DM] Interactions between Sifinity Control -
// Charger Firmware (based on OCPP 2.0.1)").
//
// Jira issue keys (/browse/EMOB-22926) are already in a usable form
// and need no decoding — `parseAtlassianCloudResourceUrl` just lifts
// them out of the URL so `match_connector_template_by_url` can return
// both the template match and the resolved resource in one shot.

/**
 * Decode an Atlassian tinyui shortlink suffix into the underlying
 * numeric page id.
 *
 * Algorithm:
 *  1. base64url-decode (pad to length % 4 == 0; map `-`→`+`, `_`→`/`).
 *  2. Read the first 4 bytes of the result as a little-endian uint32.
 *
 * Returns `null` on any input that is not a valid base64url string of
 * at least 4 decoded bytes — never throws.
 */
export function decodeAtlassianTinyui(short: string): number | null {
  if (!short || typeof short !== "string") return null;
  if (!/^[A-Za-z0-9_-]+$/.test(short)) return null;
  const padded = short + "=".repeat((4 - (short.length % 4)) % 4);
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  // Use Buffer.from(...) to match the engine's other base64 callers
  // (see apps/engine/src/crypto/). `Buffer.from(str, "base64")` accepts
  // invalid input by silently dropping non-base64 chars, but the regex
  // above already rejects anything outside the base64url alphabet so
  // the buffer cannot be "partially valid" by the time we reach here.
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length < 4) return null;
  return bytes.readUInt32LE(0);
}

/**
 * Resource-shape signalled by an Atlassian Cloud URL. The matcher
 * uses this to attach a concrete page_id / issue_key to the
 * connector-template result, so the workflow draft's first request
 * step can hit the real resource on the first dry-run.
 */
export type AtlassianCloudResource =
  | { kind: "confluence_page"; page_id: number }
  | { kind: "confluence_tinyui"; short: string; page_id: number | null }
  | { kind: "jira_issue"; key: string };

/**
 * Parse a Confluence or Jira **Cloud** URL and return the resolved
 * resource descriptor, or `null` if the URL is not a recognised
 * resource path. Atlassian Server / Data Center URLs (`*.jira-dev.com`,
 * on-prem Bitbucket, custom corporate hosts) are **not** in scope —
 * they use different URL shapes and aren't decoded here.
 *
 * Recognised shapes (Cloud only):
 *   /wiki/x/<short>                            → tinyui (decoded to page_id when possible)
 *   /wiki/spaces/<space>/pages/<id>(/...)?     → numeric page
 *   /browse/<KEY-N>                            → Jira issue
 *
 * Domain handling: the URL host must be on `*.atlassian.net` or
 * `*.atlassian.com` — passing in a non-Atlassian-Cloud URL returns
 * `null` so callers can use this as a pre-flight gate.
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
