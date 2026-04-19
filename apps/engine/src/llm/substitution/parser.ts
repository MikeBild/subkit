// Placeholder syntax recognised inside any string value that the engine hands
// to a step driver or to a conversation-tool output envelope.
//
// Five token kinds:
//
//     ${cred.<slug>.<field>}                     — credential field
//     ${connector.<slug>.base_url}               — connector base URL
//     ${connector.<slug>.config.<pointer>}       — arbitrary connector config
//     ${input.<pointer>}                         — workflow / tool input
//     ${scope.<step_id>.<pointer>}               — previous step's data envelope
//
// Escapes:
//
//     $${...}                                    — literal ${...} (NOT substituted)
//
// Grammar is deliberately conservative: identifiers are `[A-Za-z0-9_-]+`,
// segments are dot-separated, and no nested braces are allowed. The parser is a
// single-pass state machine; it never invokes `eval`, `Function`, or a regex on
// user input (regex is used only for identifier shape after extraction).
//
// The parser is pure: it does not read DB, does not resolve anything, and does
// not log token values (there are none to log — it only sees names/paths).

export type PlaceholderKind = "cred" | "connector_url" | "connector_config" | "input" | "scope";

export interface Placeholder {
  kind: PlaceholderKind;
  /** Connector or system slug, when applicable. */
  slug?: string;
  /** Credential field name, only for `cred`. */
  field?: string;
  /** Step ID, only for `scope`. */
  stepId?: string;
  /** Dotted path after the kind-specific prefix. Always non-empty except for
   * `connector_url`, where the path is always `["base_url"]`. */
  path: string[];
  /** Character span inside the source string. */
  span: { start: number; end: number };
  /** The full `${...}` substring verbatim, useful for audit logging. */
  raw: string;
}

export interface ParseError {
  code:
    | "unclosed_placeholder"
    | "empty_placeholder"
    | "unknown_kind"
    | "malformed_cred"
    | "malformed_connector"
    | "malformed_input"
    | "malformed_scope"
    | "bad_identifier";
  message: string;
  span: { start: number; end: number };
}

export interface ParseResult {
  tokens: Placeholder[];
  errors: ParseError[];
}

const IDENT = /^[A-Za-z0-9_-]+$/;

export function parsePlaceholders(text: string): ParseResult {
  const tokens: Placeholder[] = [];
  const errors: ParseError[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const ch = text.charCodeAt(i);

    // `$$` followed by `{` → escape; consume `$$` and let the `${...}` appear
    // as a literal in output. We do NOT emit a token for escaped forms.
    if (ch === 0x24 /* $ */ && i + 1 < n && text.charCodeAt(i + 1) === 0x24) {
      if (i + 2 < n && text.charCodeAt(i + 2) === 0x7b /* { */) {
        // skip the `$$`; leave `${...}` as literal — parser intentionally
        // ignores the inside of an escaped placeholder.
        i += 2;
        // now scan past the `{...}` so we don't accidentally treat it as a
        // placeholder on the next iteration.
        i = skipBalancedBraces(text, i);
        continue;
      }
      // lone `$$` not followed by `{` — treat as literal chars.
      i += 2;
      continue;
    }

    if (ch === 0x24 /* $ */ && i + 1 < n && text.charCodeAt(i + 1) === 0x7b /* { */) {
      const start = i;
      i += 2;
      const bodyStart = i;
      // Find the matching `}`. No nested braces allowed.
      let bodyEnd = -1;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 0x7d /* } */) {
          bodyEnd = i;
          break;
        }
        if (c === 0x7b /* { */) {
          errors.push({
            code: "unclosed_placeholder",
            message: "nested '{' is not allowed inside a placeholder",
            span: { start, end: i + 1 },
          });
          bodyEnd = i;
          break;
        }
        i++;
      }
      if (bodyEnd < 0) {
        errors.push({
          code: "unclosed_placeholder",
          message: `placeholder started with '\${' but no matching '}'`,
          span: { start, end: n },
        });
        break;
      }
      const body = text.slice(bodyStart, bodyEnd);
      const raw = text.slice(start, bodyEnd + 1);
      i = bodyEnd + 1;
      const parsed = parseBody(body, { start, end: bodyEnd + 1 }, raw);
      if (parsed.ok) {
        tokens.push(parsed.token);
      } else {
        errors.push(parsed.error);
      }
      continue;
    }

    i++;
  }

  return { tokens, errors };
}

export function hasPlaceholders(text: string): boolean {
  const n = text.length;
  for (let i = 0; i < n - 1; i++) {
    if (text.charCodeAt(i) === 0x24 && text.charCodeAt(i + 1) === 0x7b) {
      // `${`
      if (i > 0 && text.charCodeAt(i - 1) === 0x24) {
        // escaped `$${` — doesn't count
        continue;
      }
      return true;
    }
  }
  return false;
}

/** Strip all placeholders from the string; useful when logging a
 *  config surface without revealing even the token names (e.g. in free-form
 *  audit metadata that must not hint at which credentials exist). */
export function stripPlaceholders(text: string): string {
  const { tokens } = parsePlaceholders(text);
  if (tokens.length === 0) return text;
  // Sort by start desc so splicing doesn't shift indexes.
  const sorted = [...tokens].sort((a, b) => b.span.start - a.span.start);
  let out = text;
  for (const t of sorted) {
    out = out.slice(0, t.span.start) + out.slice(t.span.end);
  }
  return out;
}

/** Return the raw token names (e.g. `${cred.stripe.secret_key}`) without values.
 *  Safe to include in audit metadata and LLM-visible spans. */
export function collectTokenNames(text: string): string[] {
  const { tokens } = parsePlaceholders(text);
  return tokens.map((t) => t.raw);
}

// ---------------------------------------------------------------------------

function skipBalancedBraces(text: string, fromIndex: number): number {
  // fromIndex points at '{'. Returns index after matching '}'.
  let depth = 0;
  let i = fromIndex;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x7b) depth++;
    else if (c === 0x7d) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return text.length;
}

type BodyResult = { ok: true; token: Placeholder } | { ok: false; error: ParseError };

function parseBody(body: string, span: { start: number; end: number }, raw: string): BodyResult {
  if (body.length === 0) {
    return {
      ok: false,
      error: { code: "empty_placeholder", message: `\${} is not a valid placeholder`, span },
    };
  }
  const parts = body.split(".");
  const head = parts[0] ?? "";

  switch (head) {
    case "cred": {
      // ${cred.<slug>.<field>}
      if (parts.length !== 3) {
        return {
          ok: false,
          error: {
            code: "malformed_cred",
            message: `expected \${cred.<slug>.<field>}`,
            span,
          },
        };
      }
      const slug = parts[1]!;
      const field = parts[2]!;
      if (!IDENT.test(slug) || !IDENT.test(field)) {
        return {
          ok: false,
          error: { code: "bad_identifier", message: "invalid cred identifier", span },
        };
      }
      return {
        ok: true,
        token: { kind: "cred", slug, field, path: [field], span, raw },
      };
    }
    case "connector": {
      // ${connector.<slug>.base_url} | ${connector.<slug>.config.<pointer…>}
      if (parts.length < 3) {
        return {
          ok: false,
          error: {
            code: "malformed_connector",
            message: `expected \${connector.<slug>.base_url} or \${connector.<slug>.config.<path>}`,
            span,
          },
        };
      }
      const slug = parts[1]!;
      const prop = parts[2]!;
      if (!IDENT.test(slug)) {
        return {
          ok: false,
          error: { code: "bad_identifier", message: "invalid connector slug", span },
        };
      }
      if (prop === "base_url") {
        if (parts.length !== 3) {
          return {
            ok: false,
            error: {
              code: "malformed_connector",
              message: `\${connector.<slug>.base_url} takes no further path`,
              span,
            },
          };
        }
        return {
          ok: true,
          token: { kind: "connector_url", slug, path: ["base_url"], span, raw },
        };
      }
      if (prop === "config") {
        if (parts.length < 4) {
          return {
            ok: false,
            error: {
              code: "malformed_connector",
              message: `expected \${connector.<slug>.config.<path>}`,
              span,
            },
          };
        }
        const pathParts = parts.slice(3);
        for (const p of pathParts) {
          if (!IDENT.test(p)) {
            return {
              ok: false,
              error: {
                code: "bad_identifier",
                message: `invalid config path segment '${p}'`,
                span,
              },
            };
          }
        }
        return {
          ok: true,
          token: { kind: "connector_config", slug, path: pathParts, span, raw },
        };
      }
      return {
        ok: false,
        error: {
          code: "malformed_connector",
          message: `expected 'base_url' or 'config.<path>', got '${prop}'`,
          span,
        },
      };
    }
    case "input": {
      if (parts.length < 2) {
        return {
          ok: false,
          error: {
            code: "malformed_input",
            message: `expected \${input.<path>}`,
            span,
          },
        };
      }
      const pathParts = parts.slice(1);
      for (const p of pathParts) {
        if (!IDENT.test(p)) {
          return {
            ok: false,
            error: { code: "bad_identifier", message: `invalid input path segment '${p}'`, span },
          };
        }
      }
      return { ok: true, token: { kind: "input", path: pathParts, span, raw } };
    }
    case "scope": {
      // ${scope.<step_id>.<path…>}
      if (parts.length < 3) {
        return {
          ok: false,
          error: {
            code: "malformed_scope",
            message: `expected \${scope.<step_id>.<path>}`,
            span,
          },
        };
      }
      const stepId = parts[1]!;
      if (!IDENT.test(stepId)) {
        return {
          ok: false,
          error: { code: "bad_identifier", message: "invalid scope step_id", span },
        };
      }
      const pathParts = parts.slice(2);
      for (const p of pathParts) {
        if (!IDENT.test(p)) {
          return {
            ok: false,
            error: { code: "bad_identifier", message: `invalid scope path segment '${p}'`, span },
          };
        }
      }
      return { ok: true, token: { kind: "scope", stepId, path: pathParts, span, raw } };
    }
    default:
      return {
        ok: false,
        error: {
          code: "unknown_kind",
          message: `unknown placeholder kind '${head}'; expected one of: cred, connector, input, scope`,
          span,
        },
      };
  }
}
