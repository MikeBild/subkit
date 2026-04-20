// URL grounding scanner — when the model emits a URL whose origin
// looks like a subkit host (subkit-api.*, *.subkit.dev, localhost:*),
// it MUST match the per-turn `engine_url` exactly. Anything else is
// either a placeholder we missed or a leak from another tenant.
//
// Foreign hosts (github.com, anthropic.com, vendor docs) are ignored.

import type { Scanner, ScannerContext, Violation } from "../types.ts";

const SUBKIT_HOST_RE = /\b(?:[a-z0-9-]+\.)*subkit(?:[a-z0-9-]+)?(?:-[a-z0-9-]+)?\.(?:[a-z]+)\b/i;
const URL_RE = /\bhttps?:\/\/[^\s)\]\}>'"`,]+/gi;

function looksLikeSubkitOrigin(url: URL, engineUrl?: URL): boolean {
  // Always treat the engine's own host as ground truth.
  if (engineUrl && url.host === engineUrl.host) return true;
  // Heuristic match for subkit-shaped hosts (subkit-api.*, *.subkit.dev, *.subkit-*.tld).
  if (SUBKIT_HOST_RE.test(url.host)) return true;
  // Localhost / 127.* — only matters if we have an engine_url to compare to;
  // otherwise these are common in docs and produce too many false positives.
  if (engineUrl && /^(localhost|127\.|::1)/i.test(url.host)) return true;
  return false;
}

export const urlScanner: Scanner = {
  id: "url",
  scan(text: string, ctx: ScannerContext): Violation[] {
    const out: Violation[] = [];
    let engineUrl: URL | undefined;
    if (ctx.engine_url) {
      try {
        engineUrl = new URL(ctx.engine_url);
      } catch {
        /* engine_url malformed — skip the comparison entirely */
      }
    }
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
    while ((m = URL_RE.exec(text)) !== null) {
      let parsed: URL;
      try {
        parsed = new URL(m[0]);
      } catch {
        continue;
      }
      if (!looksLikeSubkitOrigin(parsed, engineUrl)) continue;
      // Same origin as engine_url? clean.
      if (engineUrl && parsed.origin === engineUrl.origin) continue;
      out.push({
        kind: "url.unknown_origin",
        message: engineUrl
          ? `Emitted a subkit-shaped URL (${parsed.origin}) that does not match the runtime engine_url (${engineUrl.origin}).`
          : `Emitted a subkit-shaped URL (${parsed.origin}) but no engine_url is in this turn's RUNTIME CONTEXT.`,
        span: { start: m.index, end: m.index + m[0].length },
        details: {
          emitted_origin: parsed.origin,
          ...(engineUrl ? { engine_url_origin: engineUrl.origin } : {}),
        },
      });
    }
    return out;
  },
};
