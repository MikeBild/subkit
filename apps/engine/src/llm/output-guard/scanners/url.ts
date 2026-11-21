import type { Scanner, ScannerContext, Violation } from "../types.ts";

const SUBKIT_HOST_RE = /\b(?:[a-z0-9-]+\.)*subkit(?:[a-z0-9-]+)?(?:-[a-z0-9-]+)?\.(?:[a-z]+)\b/i;
const URL_RE = /\bhttps?:\/\/[^\s)\]}>'"`,]+/gi;

function looksLikeSubkitOrigin(url: URL, engineUrl?: URL): boolean {
  if (engineUrl && url.host === engineUrl.host) return true;
  if (SUBKIT_HOST_RE.test(url.host)) return true;
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
      } catch {}
    }
    for (const m of text.matchAll(URL_RE)) {
      let parsed: URL;
      try {
        parsed = new URL(m[0]);
      } catch {
        continue;
      }
      if (!looksLikeSubkitOrigin(parsed, engineUrl)) continue;
      if (engineUrl && parsed.origin === engineUrl.origin) continue;
      let repair: string | undefined;
      if (engineUrl) {
        try {
          const rebuilt = new URL(m[0]);
          rebuilt.protocol = engineUrl.protocol;
          rebuilt.host = engineUrl.host;
          rebuilt.port = engineUrl.port;
          repair = rebuilt.toString();
        } catch {}
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
