// Path-input sanitizer for sk slash commands that take a filesystem
// path (`/attach`, `/knowledge`, future `/upload` variants).
//
// Copy-paste from browsers, Markdown renderers, terminal autocomplete,
// or chat clients regularly drags along invisible Unicode that turns a
// visually-correct path into one `fs.existsSync` rejects. The most
// common offenders:
//
//   U+00A0   NBSP            — pasted from Slack/Markdown rendering
//   U+200B   ZWSP            — pasted from Notion/Confluence
//   U+200C   ZWNJ
//   U+200D   ZWJ
//   U+200E   LRM
//   U+200F   RLM
//   U+FEFF   BOM / ZWNBSP    — Excel/CSV exports
//
// `sanitizePathInput` strips the zero-width set and normalises NBSP to
// a regular space so paths with embedded spaces still work. Anything
// left after that is the user's intent.
//
// `renderSuspiciousCodepoints` returns a diagnostic suffix listing
// remaining invisible codepoints, so when sanitization isn't enough the
// "not found" error can tell the user exactly what's lurking in their
// path instead of looking identical to a clean one.

const INVISIBLE_STRIP = /[\u200B-\u200F\uFEFF]/g;
const NBSP = /\u00A0/g;
const SUSPICIOUS = /[\u00A0\u200B-\u200F\uFEFF]/;

export function sanitizePathInput(s: string): string {
  return s.replace(INVISIBLE_STRIP, "").replace(NBSP, " ").trim();
}

export function renderSuspiciousCodepoints(s: string): string {
  if (!SUSPICIOUS.test(s)) return "";
  const cps = [...s].map((c) => c.codePointAt(0)?.toString(16)).join(" ");
  return ` [codepoints: ${cps}]`;
}
