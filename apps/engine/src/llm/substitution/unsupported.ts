export type UnsupportedPlaceholderCode = "mustache" | "bad_kind" | "loop_alias" | "item_alias";

export interface UnsupportedPlaceholder {
  code: UnsupportedPlaceholderCode;
  raw: string;
  span: { start: number; end: number };
  did_you_mean: string;
  message: string;
}

const MUSTACHE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const DOLLAR_RE = /\$\{([^{}]*)\}/g;

const KNOWN_KINDS = new Set([
  "cred",
  "secret",
  "connector",
  "input",
  "caller",
  "scope",
  "item",
  "state",
]);

function suggestRewrite(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "${item.<path>}";
  const t = trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
  if (/^\$?loop\.item\./.test(t) || /^\$?loop\./.test(t)) {
    const tail = t.replace(/^\$?loop\.(?:item\.)?/, "");
    return `\${item.${tail || "<path>"}}`;
  }
  if (/^item\./.test(t)) {
    return `\${${t}}`;
  }
  if (/^currentItem\./.test(t)) {
    return `\${item.${t.slice("currentItem.".length) || "<path>"}}`;
  }
  const segs = t.split(".");
  if (segs.length >= 2 && /^[a-zA-Z_][\w-]*$/.test(segs[0]!)) {
    if (KNOWN_KINDS.has(segs[0]!)) {
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

  DOLLAR_RE.lastIndex = 0;
  for (let d = DOLLAR_RE.exec(text); d !== null; d = DOLLAR_RE.exec(text)) {
    const raw = d[0]!;
    const body = d[1] ?? "";
    if (d.index > 0 && text.charCodeAt(d.index - 1) === 0x24) continue;
    const trimmed = body.trim();
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
    if (head !== null) continue;
    if (trimmed.length === 0) continue;
    out.push({
      code: "bad_kind",
      raw,
      span: { start: d.index, end: d.index + raw.length },
      did_you_mean: suggestRewrite(trimmed),
      message: `Unknown placeholder kind '${trimmed.split(".")[0] ?? ""}'. Expected one of: cred, connector, input, caller, scope, item, state.`,
    });
  }

  out.sort((a, b) => a.span.start - b.span.start);
  return out;
}
