// Bare loop-item references in JSONata, located and rewritten on the
// parsed AST.
//
// Inside a loop body the current item is `$item`; a bare `item` is not
// bound. `findBareItemRefs` locates root-context path-head `name` nodes
// for a set of names (names inside filter predicates / sort terms / group
// expressions and non-head path steps resolve against the iterated item
// and are not references). `rewriteBareItemRefs` splices `$item` in at the
// AST-reported token spans and proves the result: the re-parsed AST must
// equal the original with exactly the intended substitutions applied.
//
// Pure data — no I/O, no DB, no LLM.

import { extractAst } from "../execution/jsonata-engine.ts";

// ---------------------------------------------------------------------------
// AST walking (mirrors execution/steps/transform.ts scope rules)
// ---------------------------------------------------------------------------

interface AstNode {
  type?: string;
  value?: unknown;
  position?: number;
  steps?: unknown;
  arguments?: unknown;
  body?: unknown;
  lhs?: unknown;
  rhs?: unknown;
  expressions?: unknown;
}

/** Path-step keys whose sub-expressions evaluate against the CURRENT
 *  array item (filter / index / sort / group), not the data root. Bare
 *  names inside them are item-field lookups and must not be rewritten.
 *  Same set as `execution/steps/transform.ts`. */
const CONTEXTUAL_AST_KEYS = new Set(["stages", "predicate", "group"]);

export interface BareItemRef {
  /** The referenced bare name (one of the requested names). */
  name: string;
  /** jsonata token END position — the token spans
   *  `[position - name.length, position)` in the source. */
  position: number;
}

export type FindBareItemRefsResult =
  | { ok: true; refs: BareItemRef[] }
  | { ok: false; reason: string };

/**
 * Locate every root-context bare reference to one of `names` in a
 * JSONata expression. Returns `ok: false` when the expression cannot
 * be analysed safely (parse failure, or a reference found where the
 * `$item` binding is shadowed by a lambda argument / `:=` bind).
 */
export function findBareItemRefs(
  expression: string,
  names: ReadonlySet<string>,
): FindBareItemRefsResult {
  const ast = extractAst(expression) as AstNode | null;
  if (!ast) return { ok: false, reason: "jsonata expression failed to parse" };
  const refs: BareItemRef[] = [];
  let shadowedHit = false;

  const visit = (
    node: unknown,
    contextual: boolean,
    itemShadowed: boolean,
    isPathStep: boolean,
  ): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, contextual, itemShadowed, isPathStep);
      return;
    }
    const ast2 = node as AstNode;

    // Lambda / function definition: its `$`-arguments are in scope
    // inside the body only. A `$item` argument shadows the canonical
    // binding for the whole body.
    if (ast2.type === "lambda" || ast2.type === "function_def") {
      let shadowsItem = itemShadowed;
      if (Array.isArray(ast2.arguments)) {
        for (const a of ast2.arguments) {
          const arg = a as AstNode;
          if (arg?.type === "variable" && arg.value === "item") shadowsItem = true;
        }
      }
      if (ast2.body !== undefined) visit(ast2.body, contextual, shadowsItem, false);
      for (const [k, v] of Object.entries(ast2)) {
        if (k === "type" || k === "value" || k === "position" || k === "body") continue;
        if (k === "arguments") continue;
        visit(v, contextual || CONTEXTUAL_AST_KEYS.has(k), itemShadowed, false);
      }
      return;
    }

    // `(expr; expr; ...)` block — a `$item := …` bind shadows the
    // canonical binding for every later expression in the block.
    if (Array.isArray(ast2.expressions)) {
      let blockItemShadowed = itemShadowed;
      for (const exprNode of ast2.expressions) {
        const e = exprNode as AstNode;
        if (e?.type === "bind") {
          const lhs = e.lhs as AstNode | undefined;
          if (e.rhs !== undefined) visit(e.rhs, contextual, blockItemShadowed, false);
          if (lhs?.type === "variable" && lhs.value === "item") blockItemShadowed = true;
          continue;
        }
        visit(e, contextual, blockItemShadowed, false);
      }
      for (const [k, v] of Object.entries(ast2)) {
        if (k === "type" || k === "value" || k === "position" || k === "expressions") continue;
        visit(v, contextual || CONTEXTUAL_AST_KEYS.has(k), itemShadowed, false);
      }
      return;
    }

    if (ast2.type === "path" && Array.isArray(ast2.steps) && ast2.steps.length >= 1) {
      const steps = ast2.steps as AstNode[];
      const head = steps[0];
      if (
        head?.type === "name" &&
        typeof head.value === "string" &&
        !contextual &&
        names.has(head.value) &&
        typeof head.position === "number"
      ) {
        if (itemShadowed) shadowedHit = true;
        refs.push({ name: head.value, position: head.position });
      }
      // The head's own decorations (stages etc.) are contextual; later
      // steps resolve against the previous step's output — contextual.
      visit(head, contextual, itemShadowed, true);
      for (let i = 1; i < steps.length; i++) {
        visit(steps[i], true, itemShadowed, true);
      }
      for (const [k, v] of Object.entries(ast2)) {
        if (k === "type" || k === "value" || k === "position" || k === "steps") continue;
        visit(v, contextual || CONTEXTUAL_AST_KEYS.has(k), itemShadowed, false);
      }
      return;
    }

    for (const [k, v] of Object.entries(ast2)) {
      if (k === "type" || k === "value" || k === "position") continue;
      visit(v, contextual || CONTEXTUAL_AST_KEYS.has(k), itemShadowed, false);
    }
  };

  visit(ast, false, false, false);
  if (shadowedHit) {
    return {
      ok: false,
      reason: "a bare item reference is shadowed by a `$item` lambda argument or `$item :=` bind",
    };
  }
  // Dedupe by position (a node can only be visited once, but be safe).
  const seen = new Set<number>();
  const deduped: BareItemRef[] = [];
  for (const r of refs) {
    if (seen.has(r.position)) continue;
    seen.add(r.position);
    deduped.push(r);
  }
  return { ok: true, refs: deduped };
}

// ---------------------------------------------------------------------------
// Structural equivalence proof
// ---------------------------------------------------------------------------

/** Deep-clone the AST applying the intended substitution: every `name`
 *  node whose token END position is in `positions` becomes a
 *  `variable: "item"` node. Everything else is copied verbatim
 *  (positions dropped — they shift under the splice by construction). */
function mapAst(node: unknown, positions: ReadonlySet<number>, name: string): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((c) => mapAst(c, positions, name));
  if (node instanceof RegExp) return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const isTarget =
    src.type === "name" &&
    src.value === name &&
    typeof src.position === "number" &&
    positions.has(src.position);
  for (const [k, v] of Object.entries(src)) {
    if (k === "position") continue;
    if (isTarget && k === "type") {
      out.type = "variable";
      continue;
    }
    if (isTarget && k === "value") {
      out.value = "item";
      continue;
    }
    out[k] = mapAst(v, positions, name);
  }
  return out;
}

/** Normalise an AST for structural comparison:
 *    - drop `position` keys,
 *    - rename `predicate` → `stages` (jsonata uses `predicate` on
 *      standalone variables and `stages` on path-step names for the
 *      same `[…]` construct),
 *    - collapse a bare single-step path (`{type:"path", steps:[v]}`
 *      with no other keys) into the step node itself — jsonata parses
 *      `num` as a one-step path but `$item` as a bare variable. */
function normalizeAst(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(normalizeAst);
  if (node instanceof RegExp) return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "position") continue;
    const key = k === "predicate" ? "stages" : k;
    out[key] = normalizeAst(v);
  }
  const keys = Object.keys(out);
  if (
    out.type === "path" &&
    Array.isArray(out.steps) &&
    (out.steps as unknown[]).length === 1 &&
    keys.every((k) => k === "type" || k === "steps")
  ) {
    return (out.steps as unknown[])[0];
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && String(a) === String(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.hasOwn(b as Record<string, unknown>, k)) return false;
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Single-expression rewrite
// ---------------------------------------------------------------------------

export type ExpressionRewrite =
  | { ok: true; changed: boolean; rewritten: string }
  | { ok: false; reason: string };

/**
 * Rewrite every root-context bare reference to `name` in a JSONata
 * expression to `$item`, then PROVE the rewrite: re-parse and assert
 * AST structural equality with the original modulo the intended
 * substitution. Any inequality → `ok: false` (caller must leave the
 * workflow untouched).
 */
export function rewriteBareItemRefs(expression: string, name: string): ExpressionRewrite {
  const found = findBareItemRefs(expression, new Set([name]));
  if (!found.ok) return { ok: false, reason: found.reason };
  if (found.refs.length === 0) return { ok: true, changed: false, rewritten: expression };

  // Splice the source at each token span, verified against the text
  // (backtick-quoted names report the same value but a different span —
  // the verification below catches and refuses them).
  const spans = found.refs
    .map((r) => ({ start: r.position - name.length, end: r.position }))
    .sort((a, b) => b.start - a.start);
  let rewritten = expression;
  for (const s of spans) {
    if (s.start < 0 || expression.slice(s.start, s.end) !== name) {
      return {
        ok: false,
        reason: `token span mismatch at position ${s.end} (quoted or non-literal name)`,
      };
    }
    rewritten = `${rewritten.slice(0, s.start)}$item${rewritten.slice(s.end)}`;
  }

  const originalAst = extractAst(expression);
  const rewrittenAst = extractAst(rewritten);
  if (!originalAst || !rewrittenAst) {
    return { ok: false, reason: "rewritten expression failed to re-parse" };
  }
  const positions = new Set(found.refs.map((r) => r.position));
  const expected = normalizeAst(mapAst(originalAst, positions, name));
  const actual = normalizeAst(rewrittenAst);
  if (!deepEqual(expected, actual)) {
    return {
      ok: false,
      reason:
        "equivalence proof failed: rewritten AST is not the original modulo the name→$item mapping",
    };
  }
  return { ok: true, changed: true, rewritten };
}
