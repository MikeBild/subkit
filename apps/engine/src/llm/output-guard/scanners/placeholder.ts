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

import type { Scanner, ScannerContext, Violation } from "../types.ts";

interface Pattern {
  kind: string;
  re: RegExp;
  message: string;
  /**
   * When true, and `ctx.engine_url` is available, the matched span is
   * repaired in-place with the grounded origin's host (preserving the
   * surrounding scheme / path). Lets the user get a usable config on
   * the first turn instead of a `[guard:placeholder.host]` marker.
   */
  repairFromEngineUrl?: boolean;
}

const PATTERNS: Pattern[] = [
  {
    kind: "placeholder.host",
    re: /\byour[-_]?subkit[-_]?(instance|host|domain)(?:\.[a-z]+)+/gi,
    message:
      "Used `your-subkit-instance.com`-style placeholder host. Use the `engine_url` from the RUNTIME CONTEXT block, or call cannot_help if it is missing.",
    repairFromEngineUrl: true,
  },
  {
    kind: "placeholder.host",
    re: /\b(?:your[-_]?(?:host|domain|server|engine)|example)\.(?:com|io|dev|net|org)\b/gi,
    message:
      "Used a placeholder host (your-host.com / example.com). Use the real `engine_url` from the RUNTIME CONTEXT block.",
    repairFromEngineUrl: true,
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
    message:
      "Emitted the literal `<placeholder>` token. Replace with a real value or call cannot_help.",
  },
];

function engineHostFromCtx(ctx: ScannerContext): string | undefined {
  if (!ctx.engine_url) return undefined;
  try {
    return new URL(ctx.engine_url).host;
  } catch {
    return undefined;
  }
}

export const placeholderScanner: Scanner = {
  id: "placeholder",
  scan(text: string, ctx: ScannerContext): Violation[] {
    const out: Violation[] = [];
    const engineHost = engineHostFromCtx(ctx);
    for (const p of PATTERNS) {
      // Fresh exec loop so the global flag's lastIndex does not stick across calls.
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
      while ((m = p.re.exec(text)) !== null) {
        const violation: Violation = {
          kind: p.kind,
          message: p.message,
          span: { start: m.index, end: m.index + m[0].length },
          details: { match: m[0] },
        };
        // Heal placeholder hosts in-place when we know the grounded host.
        // Only the host substring is repaired; surrounding scheme/path
        // are untouched. Falls through to the standard `[guard:…]`
        // marker when the runtime context does not expose engine_url.
        if (p.repairFromEngineUrl && engineHost) {
          violation.repair = engineHost;
          (violation.details as Record<string, unknown>).repaired_to = engineHost;
        }
        out.push(violation);
        if (m[0].length === 0) p.re.lastIndex += 1; // safety against zero-width
      }
    }
    return out;
  },
};
