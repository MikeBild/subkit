// URL grounding scanner — when the model emits a URL whose origin
// looks like a subkit host (subkit-api.*, *.subkit.dev, localhost:*),
// it MUST match the per-turn `engine_url` exactly. Anything else is
// either a placeholder we missed or a leak from another tenant.
//
// Foreign hosts (github.com, anthropic.com, vendor docs) are ignored.

import type { Scanner, ScannerContext, Violation } from "../types.ts";

const SUBKIT_HOST_RE = /\b(?:[a-z0-9-]+\.)*subkit(?:[a-z0-9-]+)?(?:-[a-z0-9-]+)?\.(?:[a-z]+)\b/i;
const URL_RE = /\bhttps?:\/\/[^\s)\]}>'"`,]+/gi;

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
    // eslint-disable-next-line no-cond-assign -- standard regex exec loop.
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
      // Compute an in-place repair when we have an engine_url — rewrite
      // the emitted URL's origin to the grounded origin while preserving
      // path, query, and hash. This heals the common case where the
      // model picks the wrong scheme (https://<real-host> vs http://…)
      // or a stale host, so the user's config is usable on the first
      // turn instead of being flagged and left unrepaired.
      let repair: string | undefined;
      if (engineUrl) {
        try {
          const rebuilt = new URL(m[0]);
          rebuilt.protocol = engineUrl.protocol;
          rebuilt.host = engineUrl.host;
          rebuilt.port = engineUrl.port;
          repair = rebuilt.toString();
        } catch {
          /* noop — fall back to the `[guard:…]` marker */
        }
      }
      out.push({
        kind: "url.unknown_origin",
        message: engineUrl
          ? `Emitted a subkit-shaped URL (${parsed.origin}) that does not match the runtime engine_url (${engineUrl.origin}).`
          : `Emitted a subkit-shaped URL (${parsed.origin}) but no engine_url is in this turn's RUNTIME CONTEXT.`,
        span: { start: m.index, end: m.index + m[0].length },
        details: {
          emitted_origin: parsed.origin,
          ...(engineUrl ? { engine_url_origin: engineUrl.origin } : {}),
          ...(repair ? { repaired_to: repair } : {}),
        },
        ...(repair ? { repair } : {}),
      });
    }
    return out;
  },
};
