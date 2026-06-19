// JSONPath-lite. Subset:
//   $              -> root
//   .key           -> object property access
//   ['key']        -> bracketed object access (allows dots / spaces)
//   [N]            -> integer index
//   [N:M]          -> array slice
//   [*]            -> wildcard expanding all elements/values
//
// Unsupported: filters (?), descendants (..), unions, scripts.
// The selector compiles to a list of operations; applying the operations
// against a value returns either a single value or an array (for any path
// that traverses a wildcard / slice).

type Op =
  | { type: "key"; key: string }
  | { type: "index"; index: number }
  | { type: "slice"; start: number; end: number | null }
  | { type: "wildcard" };

interface Compiled {
  ops: Op[];
}

const TOKEN_RE = /\.(\w+)|\[(\*|-?\d+(?::-?\d+)?|'[^']*'|"[^"]*")\]/g;

export function compileSelector(expr: string): Compiled {
  if (!expr || expr[0] !== "$") {
    throw new Error("selector must start with $");
  }
  const rest = expr.slice(1);
  const ops: Op[] = [];
  let consumed = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null = TOKEN_RE.exec(rest);
  while (m !== null) {
    if (m.index !== consumed) {
      throw new Error(`unexpected token at ${m.index} in ${expr}`);
    }
    consumed = m.index + m[0].length;
    if (m[1] !== undefined) {
      ops.push({ type: "key", key: m[1] });
    } else if (m[2] !== undefined) {
      const inner = m[2];
      if (inner === "*") {
        ops.push({ type: "wildcard" });
      } else if (inner.startsWith("'") || inner.startsWith('"')) {
        ops.push({ type: "key", key: inner.slice(1, -1) });
      } else if (inner.includes(":")) {
        const [s, e] = inner.split(":");
        ops.push({
          type: "slice",
          start: Number.parseInt(s ?? "0", 10) || 0,
          end: e === "" || e === undefined ? null : Number.parseInt(e, 10),
        });
      } else {
        ops.push({ type: "index", index: Number.parseInt(inner, 10) });
      }
    }
    m = TOKEN_RE.exec(rest);
  }
  if (consumed !== rest.length) {
    throw new Error(`trailing junk in selector: ${expr.slice(consumed + 1)}`);
  }
  return { ops };
}

export function applySelector(expr: string, value: unknown): unknown {
  const { ops } = compileSelector(expr);
  return apply(ops, value);
}

function apply(ops: Op[], value: unknown): unknown {
  let current: unknown[] = [value];
  let multi = false;
  for (const op of ops) {
    const next: unknown[] = [];
    for (const v of current) {
      if (v == null) continue;
      if (op.type === "key") {
        if (typeof v === "object" && !Array.isArray(v)) {
          next.push((v as Record<string, unknown>)[op.key]);
        }
      } else if (op.type === "index") {
        if (Array.isArray(v)) {
          const i = op.index < 0 ? v.length + op.index : op.index;
          next.push(v[i]);
        }
      } else if (op.type === "slice") {
        if (Array.isArray(v)) {
          const len = v.length;
          const start = op.start < 0 ? Math.max(0, len + op.start) : Math.min(op.start, len);
          const end =
            op.end === null ? len : op.end < 0 ? Math.max(0, len + op.end) : Math.min(op.end, len);
          for (const item of v.slice(start, end)) next.push(item);
          multi = true;
        }
      } else if (op.type === "wildcard") {
        if (Array.isArray(v)) {
          for (const item of v) next.push(item);
        } else if (typeof v === "object") {
          for (const item of Object.values(v as Record<string, unknown>)) next.push(item);
        }
        multi = true;
      }
    }
    current = next;
  }
  if (multi) return current;
  return current[0];
}
