// Placeholder scanner — flags placeholder hosts, fake URLs, masked-key
// templates and similar "fill-in-the-blank" markers that the assistant
// has no business producing. Each match is one violation; the scanner
// never deduplicates so the operator sees how many times the model
// reached for a given placeholder.
//
// The blacklist is intentionally narrow: only patterns that have no
// legitimate use in subkit's chat surface. False positives on quoted
// example text inside docs are acceptable — the assistant should not
// be quoting "<your-host>" verbatim either; it should be calling
// cannot_help instead.

import type { Scanner, Violation } from "../types.ts";

interface Pattern {
  kind: string;
  re: RegExp;
  message: string;
}

const PATTERNS: Pattern[] = [
  {
    kind: "placeholder.host",
    re: /\byour[-_]?subkit[-_]?(instance|host|domain)(?:\.[a-z]+)+/gi,
    message:
      "Used `your-subkit-instance.com`-style placeholder host. Use the `engine_url` from the RUNTIME CONTEXT block, or call cannot_help if it is missing.",
  },
  {
    kind: "placeholder.host",
    re: /\b(?:your[-_]?(?:host|domain|server|engine)|example)\.(?:com|io|dev|net|org)\b/gi,
    message:
      "Used a placeholder host (your-host.com / example.com). Use the real `engine_url` from the RUNTIME CONTEXT block.",
  },
  {
    kind: "placeholder.angle",
    re: /<YOUR_[A-Z][A-Z0-9_]*>/g,
    message:
      "Emitted an `<YOUR_*>` placeholder. Either fetch the real value via a tool (e.g. `create_api_key` for keys, `whoami` for tenant info) or call cannot_help.",
  },
  {
    kind: "placeholder.key_template",
    re: /\[(?:rest[-_]of[-_][a-z-]+|YOUR[_-][A-Z]+)\]/gi,
    message:
      "Emitted a `[rest-of-your-key]`-style placeholder. Call `create_api_key` to mint a full paste-ready key once, then surface it verbatim.",
  },
  {
    kind: "placeholder.angle_generic",
    re: /<placeholder>/gi,
    message: "Emitted the literal `<placeholder>` token. Replace with a real value or call cannot_help.",
  },
];

export const placeholderScanner: Scanner = {
  id: "placeholder",
  scan(text: string): Violation[] {
    const out: Violation[] = [];
    for (const p of PATTERNS) {
      // Fresh exec loop so the global flag's lastIndex does not stick across calls.
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
      while ((m = p.re.exec(text)) !== null) {
        out.push({
          kind: p.kind,
          message: p.message,
          span: { start: m.index, end: m.index + m[0].length },
          details: { match: m[0] },
        });
        if (m[0].length === 0) p.re.lastIndex += 1; // safety against zero-width
      }
    }
    return out;
  },
};
