export type PlaceholderKind =
  | "cred"
  | "connector_url"
  | "connector_config"
  | "input"
  | "caller"
  | "scope"
  | "item"
  | "state";

export interface Placeholder {
  kind: PlaceholderKind;
  slug?: string;
  field?: string;
  stepId?: string;
  path: string[];
  span: { start: number; end: number };
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
    | "malformed_caller"
    | "malformed_scope"
    | "malformed_item"
    | "malformed_state"
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

    if (ch === 0x24 && i + 1 < n && text.charCodeAt(i + 1) === 0x24) {
      if (i + 2 < n && text.charCodeAt(i + 2) === 0x7b) {
        i += 2;
        i = skipBalancedBraces(text, i);
        continue;
      }
      i += 2;
      continue;
    }

    if (ch === 0x24 && i + 1 < n && text.charCodeAt(i + 1) === 0x7b) {
      const start = i;
      i += 2;
      const bodyStart = i;
      let bodyEnd = -1;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 0x7d) {
          bodyEnd = i;
          break;
        }
        if (c === 0x7b) {
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
      if (i > 0 && text.charCodeAt(i - 1) === 0x24) {
        continue;
      }
      return true;
    }
  }
  return false;
}

export function stripPlaceholders(text: string): string {
  const { tokens } = parsePlaceholders(text);
  if (tokens.length === 0) return text;
  const sorted = [...tokens].sort((a, b) => b.span.start - a.span.start);
  let out = text;
  for (const t of sorted) {
    out = out.slice(0, t.span.start) + out.slice(t.span.end);
  }
  return out;
}

export function collectTokenNames(text: string): string[] {
  const { tokens } = parsePlaceholders(text);
  return tokens.map((t) => t.raw);
}

function skipBalancedBraces(text: string, fromIndex: number): number {
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
    case "caller": {
      if (parts.length !== 2 || !IDENT.test(parts[1] ?? "")) {
        return {
          ok: false,
          error: {
            code: "malformed_caller",
            message: `expected \${caller.<field>}`,
            span,
          },
        };
      }
      return { ok: true, token: { kind: "caller", path: [parts[1]!], span, raw } };
    }
    case "scope": {
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
    case "item": {
      if (parts.length < 2) {
        return {
          ok: false,
          error: {
            code: "malformed_item",
            message: `expected \${item.<path>}`,
            span,
          },
        };
      }
      const pathParts = parts.slice(1);
      for (const p of pathParts) {
        if (!IDENT.test(p)) {
          return {
            ok: false,
            error: { code: "bad_identifier", message: `invalid item path segment '${p}'`, span },
          };
        }
      }
      return { ok: true, token: { kind: "item", path: pathParts, span, raw } };
    }
    case "state": {
      if (parts.length < 2) {
        return {
          ok: false,
          error: {
            code: "malformed_state",
            message: `expected \${state.<into_var>} or \${state.<into_var>.<path>}`,
            span,
          },
        };
      }
      const pathParts = parts.slice(1);
      for (const p of pathParts) {
        if (!IDENT.test(p)) {
          return {
            ok: false,
            error: { code: "bad_identifier", message: `invalid state path segment '${p}'`, span },
          };
        }
      }
      return { ok: true, token: { kind: "state", path: pathParts, span, raw } };
    }
    default:
      return {
        ok: false,
        error: {
          code: "unknown_kind",
          message: `unknown placeholder kind '${head}'; expected one of: cred, connector, input, caller, scope, item, state`,
          span,
        },
      };
  }
}
