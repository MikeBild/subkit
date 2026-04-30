// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${…}` tokens are the subject under test/detection — these strings encode the placeholder grammar.
// Detects placeholder-shaped substrings the runtime will NOT substitute.
//
// Pre-fix, the LLM author repeatedly wrote Mustache placeholders
// (`{{ $item.id }}`, `{{ $loop.item.id }}`) and runtime shipped them
// verbatim to the upstream API — `URL` percent-encoded the curly braces
// and DigitalOcean returned 404. Session f00b8d1c spent 16 of its 19
// 404s on this single mistake. The lone signal back to the LLM was
// `http 404` with no hint that the path contained an unsubstituted
// placeholder.
//
// `findUnsupportedPlaceholders()` walks any string field a draft author
// might write (URL, path, header values, query values, body strings, even
// JSONata expressions) and flags every shape the parser rejects, with a
// concrete `did_you_mean` rewrite. The reference-validator wires this in
// at draft validation time so the LLM gets the fix on the next round-
// trip rather than after a doomed dry-run.

export type UnsupportedPlaceholderCode =
  | "mustache" // {{ ... }}
  | "bad_kind" // ${user.X} / ${project.X} / ${data.X}
  | "loop_alias" // ${$loop.X} / ${loop.X} (legacy LLM guesses)
  | "item_alias"; // ${$item.X} (mistakes JSONata binding for placeholder)

export interface UnsupportedPlaceholder {
  code: UnsupportedPlaceholderCode;
  /** The literal substring the author wrote. */
  raw: string;
  /** Character span inside the source string. */
  span: { start: number; end: number };
  /** Concrete fix suggestion the author can copy-paste. */
  did_you_mean: string;
  /** Human-readable explanation surfaced to the LLM. */
  message: string;
}

const MUSTACHE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const DOLLAR_RE = /\$\{([^{}]*)\}/g;

const KNOWN_KINDS = new Set(["cred", "connector", "input", "scope", "item"]);

/**
 * Best-effort rewrite of a Mustache or bad-`${...}` body into the canonical
 * `${item.X}` / `${scope.<step>.X}` / `${input.X}` form. Returns the original
 * substring with `${item.<path>}` shape when no better guess exists.
 */
function suggestRewrite(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "${item.<path>}";
  // Strip leading `$` so `$item.id` and `item.id` both rewrite the same way.
  const t = trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
  // Common author guesses we've seen in real sessions:
  //   $loop.item.X / loop.item.X     → ${item.X}
  //   $item.X                        → ${item.X}
  //   user.X / project.X / it.X      → ${item.X}  (typical loop-item alias)
  //   <step_id>.<path>               → ${scope.<step_id>.<path>}
  if (/^\$?loop\.item\./.test(t) || /^\$?loop\./.test(t)) {
    const tail = t.replace(/^\$?loop\.(?:item\.)?/, "");
    return `\${item.${tail || "<path>"}}`;
  }
  if (/^item\./.test(t)) {
    return `\${${t}}`;
  }
  // `currentItem.X` is the reference-impl idiom; map to `${item.X}` for
  // authors who copied a pattern from external docs.
  if (/^currentItem\./.test(t)) {
    return `\${item.${t.slice("currentItem.".length) || "<path>"}}`;
  }
  // Two or more dots → looks like `<step_id>.<path>`. Prefix `scope.`.
  const segs = t.split(".");
  if (segs.length >= 2 && /^[a-zA-Z_][\w-]*$/.test(segs[0]!)) {
    if (KNOWN_KINDS.has(segs[0]!)) {
      // Already a kind, just well-formed `${...}` would have parsed.
      return `\${${t}}`;
    }
    return `\${scope.${t}}`;
  }
  return `\${item.${t || "<path>"}}`;
}

function detectKnownKind(body: string): string | null {
  const head = body.split(".")[0]?.trim() ?? "";
  return KNOWN_KINDS.has(head) ? head : null;
}

export function findUnsupportedPlaceholders(text: string): UnsupportedPlaceholder[] {
  const out: UnsupportedPlaceholder[] = [];

  // Mustache: every `{{ ... }}` is unsupported (the runtime never honoured
  // it; the LLM keeps trying because it works in templating engines it
  // saw at training time).
  MUSTACHE_RE.lastIndex = 0;
  for (let m = MUSTACHE_RE.exec(text); m !== null; m = MUSTACHE_RE.exec(text)) {
    const raw = m[0]!;
    const body = (m[1] ?? "").trim();
    out.push({
      code: "mustache",
      raw,
      span: { start: m.index, end: m.index + raw.length },
      did_you_mean: suggestRewrite(body),
      message:
        "Mustache `{{ ... }}` is never substituted by the engine — the literal string ships upstream and the URL gets percent-encoded. Use the `${...}` placeholder grammar instead.",
    });
  }

  // `${...}` walker — only flag bodies that the parser would reject.
  // Skip well-formed `${kind...}` placeholders (the parser already
  // accepts them).
  DOLLAR_RE.lastIndex = 0;
  for (let d = DOLLAR_RE.exec(text); d !== null; d = DOLLAR_RE.exec(text)) {
    const raw = d[0]!;
    const body = d[1] ?? "";
    // `$$` escape: `$${...}` is a literal — skip when preceded by `$`.
    if (d.index > 0 && text.charCodeAt(d.index - 1) === 0x24 /* $ */) continue;
    const trimmed = body.trim();
    // `$loop`, `$item`, `$scope` — JSONata bindings, not placeholders.
    if (/^\$loop(\b|\.)/.test(trimmed) || /^loop\./.test(trimmed)) {
      out.push({
        code: "loop_alias",
        raw,
        span: { start: d.index, end: d.index + raw.length },
        did_you_mean: suggestRewrite(trimmed),
        message:
          "`${$loop...}` / `${loop...}` is not a placeholder kind. Inside a loop body use `${item.<path>}`; the JSONata `$loop_index` / `$item` bindings only work inside JSONata transform expressions.",
      });
      continue;
    }
    if (/^\$item(\b|\.)/.test(trimmed)) {
      out.push({
        code: "item_alias",
        raw,
        span: { start: d.index, end: d.index + raw.length },
        did_you_mean: `\${item.${trimmed.replace(/^\$item\.?/, "") || "<path>"}}`,
        message:
          "`${$item.X}` mixes JSONata binding syntax with placeholder syntax. Inside a string field write `${item.X}`; `$item` (with the dollar) is the JSONata binding name and only resolves inside transform expressions.",
      });
      continue;
    }
    const head = detectKnownKind(trimmed);
    if (head !== null) continue; // Real placeholder; parser handles malformed shapes itself.
    if (trimmed.length === 0) continue; // empty placeholder caught by parser
    out.push({
      code: "bad_kind",
      raw,
      span: { start: d.index, end: d.index + raw.length },
      did_you_mean: suggestRewrite(trimmed),
      message: `Unknown placeholder kind '${trimmed.split(".")[0] ?? ""}'. Expected one of: cred, connector, input, scope, item.`,
    });
  }

  // Sort by span.start so authors see issues in source order.
  out.sort((a, b) => a.span.start - b.span.start);
  return out;
}
