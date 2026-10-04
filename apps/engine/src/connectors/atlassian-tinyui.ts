export function decodeAtlassianTinyui(short: string): number | null {
  if (!short || typeof short !== "string") return null;
  if (!/^[A-Za-z0-9_-]+$/.test(short)) return null;
  const padded = short + "=".repeat((4 - (short.length % 4)) % 4);
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length < 4) return null;
  return bytes.readUInt32LE(0);
}

export type AtlassianCloudResource =
  | { kind: "confluence_page"; page_id: number }
  | { kind: "confluence_tinyui"; short: string; page_id: number | null }
  | { kind: "jira_issue"; key: string };

export function parseAtlassianCloudResourceUrl(rawUrl: string): AtlassianCloudResource | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/\.atlassian\.(net|com)$/i.test(url.hostname)) return null;
  const tinyuiMatch = url.pathname.match(/^\/wiki\/x\/([A-Za-z0-9_-]+)\/?$/);
  if (tinyuiMatch) {
    const short = tinyuiMatch[1]!;
    return {
      kind: "confluence_tinyui",
      short,
      page_id: decodeAtlassianTinyui(short),
    };
  }
  const pageMatch = url.pathname.match(/^\/wiki\/spaces\/[^/]+\/pages\/(\d+)(?:\/|$)/);
  if (pageMatch) {
    const pageId = Number.parseInt(pageMatch[1]!, 10);
    if (Number.isFinite(pageId)) return { kind: "confluence_page", page_id: pageId };
  }
  const issueMatch = url.pathname.match(/^\/browse\/([A-Z][A-Z0-9]+-\d+)\/?$/);
  if (issueMatch) {
    return { kind: "jira_issue", key: issueMatch[1]! };
  }
  return null;
}
