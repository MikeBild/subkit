// Transform step driver. Supports two languages:
//   - `jsonata` (default): the expression is a JSONata program
//     evaluated against the execution scope plus a `$input` binding.
//   - `javascript` (P14): the expression is a function body executed in
//     the QuickJS sandbox. The JS sees `input` with the full execution
//     scope, and its return value becomes the step output.
//
// The transform timeout tier (default 10 minutes) applies to both
// languages — JSONata races against an abort signal; JavaScript races
// against the QuickJS wall-clock budget plus the same abort signal.

import { logger } from "../../logging/logger.ts";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import {
  SandboxInterruptError,
  SandboxMemoryError,
  SandboxTimeoutError,
} from "../../sandboxes/quickjs/types.ts";
import { extractStepIdReferences, suggestClosest } from "../../workflows/levenshtein.ts";
import { enumerateScopePaths } from "../../workflows/scope-shape.ts";
import type { TransformStep } from "../../workflows/types.ts";
import { combineSignals } from "../abort.ts";
import { buildJsonataBindings } from "../jsonata-bindings.ts";
import { compile as compileJsonata, extractAst } from "../jsonata-engine.ts";
import { TRANSFORM_TIMEOUT_DEFAULT_MS } from "../timeouts.ts";
import type { StepResult, StepRunContext, StepWarning } from "../types.ts";
import { buildStepErrorDetail } from "./error-detail.ts";
import { runHtmlToMarkdown, runReadability, runStructuredData } from "./transform-web-scraper.ts";

export interface RunTransformParams {
  ctx: StepRunContext;
  step: TransformStep;
  scope: Record<string, unknown>;
  input: unknown;
}

// Walk a parsed jsonata AST collecting top-level identifiers — the
// first step of any `path` node, plus standalone `variable` nodes
// (`$foo`). Any identifier not in `known` surfaces as an
// `unresolved_identifier` warning. The walker is scope-aware so it
// does NOT flag identifiers that were introduced by the expression
// itself:
//
//   - `function($r){...}` / lambda arguments: `$r` is in scope inside
//     the body. Shows up in AST as `lambda` / `function_def` nodes
//     with `arguments: [{ type: "variable", value: "r" }, ...]`.
//   - `$foo := expr` bindings: the `bind`-type node has a `lhs`
//     variable that becomes available to everything after it.
//   - `let`/`let_expression` bindings (older jsonata AST shape).
//
// Without this, writing `$filter(data, function($r) { $r.private })`
// produced three spurious "unresolved_identifier" warnings ($r, plus
// any locals) and confused LLMs into rewriting the expression with
// worse shapes. Recurses over own properties for arbitrary nesting.
interface AstNode {
  type?: string;
  value?: unknown;
  steps?: unknown;
  arguments?: unknown;
  body?: unknown;
  lhs?: unknown;
  rhs?: unknown;
  expressions?: unknown;
}

function collectLocalBindings(node: AstNode, add: (name: string) => void): void {
  // Lambda / anonymous function args: { type: "lambda" | "function_def",
  // arguments: [{ type: "variable", value: "r" }, ...] }.
  if (
    (node.type === "lambda" || node.type === "function" || node.type === "function_def") &&
    Array.isArray(node.arguments)
  ) {
    for (const a of node.arguments) {
      const arg = a as AstNode;
      if (arg?.type === "variable" && typeof arg.value === "string") add(`$${arg.value}`);
    }
  }
}

function visitRootIdentifiers(node: unknown, emit: (id: string) => void): void {
  visitWithScope(node, emit, new Set<string>(), false);
}

// Path-step keys that hold a filter / index / sort / group sub-expression
// (`arr[pred]`, `arr^(field)`, `arr{...}`). Inside these, a bare field
// name resolves against the CURRENT array item (the implicit `$`
// context), not the data root — so `edges[node.isConnected = true]` is
// valid even though `node` is in no scope. The walker must NOT flag
// bare names inside these as unresolved; `$`-prefixed references inside
// them are still real and stay checked.
const CONTEXTUAL_AST_KEYS = new Set(["stages", "predicate", "group"]);

function visitWithScope(
  node: unknown,
  emit: (id: string) => void,
  scoped: ReadonlySet<string>,
  contextual: boolean,
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) visitWithScope(child, emit, scoped, contextual);
    return;
  }
  const ast = node as AstNode;

  // Lambda/function: its arguments are in scope inside the body only.
  if (ast.type === "lambda" || ast.type === "function_def") {
    const inner = new Set(scoped);
    collectLocalBindings(ast, (n) => inner.add(n));
    if (ast.body !== undefined) visitWithScope(ast.body, emit, inner, contextual);
    // Default arg values / procedure identifier (if any) still live
    // in the outer scope.
    for (const [k, v] of Object.entries(ast)) {
      if (k === "type" || k === "value" || k === "position" || k === "body" || k === "arguments") {
        continue;
      }
      visitWithScope(v, emit, scoped, contextual || CONTEXTUAL_AST_KEYS.has(k));
    }
    return;
  }

  // `$name := expr` — the RHS runs in the outer scope, but the name
  // becomes available for any subsequent nodes in the enclosing
  // expression block.
  if (ast.type === "bind") {
    const lhs = ast.lhs as AstNode | undefined;
    if (lhs?.type === "variable" && typeof lhs.value === "string") {
      // Visit RHS first (outer scope) so a `self-referential` bind
      // would still warn. Then the name joins the caller's scope via
      // the `block`/expression list handler below.
      if (ast.rhs !== undefined) visitWithScope(ast.rhs, emit, scoped, contextual);
      // Note: we intentionally do not emit lhs as unresolved; it's
      // being defined here. The block-level walker tracks the bind.
      return;
    }
  }

  // `(expr; expr; ...)` block / `expressions` list — bindings declared
  // earlier are visible to later expressions. Drizzle shape: `{ type:
  // "block", expressions: [...] }` or similar. We scan the list in
  // order and grow the scope as we encounter `bind` nodes.
  if (Array.isArray(ast.expressions)) {
    const inner = new Set(scoped);
    for (const exprNode of ast.expressions) {
      const e = exprNode as AstNode;
      if (e?.type === "bind") {
        const lhs = e.lhs as AstNode | undefined;
        if (lhs?.type === "variable" && typeof lhs.value === "string") {
          if (e.rhs !== undefined) visitWithScope(e.rhs, emit, inner, contextual);
          inner.add(`$${lhs.value}`);
          continue;
        }
      }
      visitWithScope(e, emit, inner, contextual);
    }
    // Walk any siblings beyond `expressions` (shouldn't exist, but
    // safe).
    for (const [k, v] of Object.entries(ast)) {
      if (k === "type" || k === "value" || k === "position" || k === "expressions") continue;
      visitWithScope(v, emit, inner, contextual || CONTEXTUAL_AST_KEYS.has(k));
    }
    return;
  }

  if (ast.type === "path" && Array.isArray(ast.steps) && ast.steps.length >= 1) {
    const steps = ast.steps as AstNode[];
    const head = steps[0];
    // A bare-name path head inside a filter/sort/group predicate
    // resolves against the iterated item, not the data root — do not
    // flag it. `$`-prefixed heads are real references and stay checked.
    if (head?.type === "name" && typeof head.value === "string" && !contextual) {
      emit(head.value);
    }
    if (head?.type === "variable" && typeof head.value === "string") {
      const id = `$${head.value}`;
      if (!scoped.has(id)) emit(id);
    }
    // The head fixes the context; every later step — a nested field,
    // an object-constructor projection `.{...}`, an attached predicate
    // — is evaluated against the previous step's output. Bare names
    // there resolve against that item, NOT the data root, so they must
    // be walked contextually. Without this, a valid projection like
    // `$input.{ 'x': value }` flagged `value` as unresolved, which the
    // dry-run then promoted to a spurious `requires_repair`.
    // `$`-prefixed references inside stay checked (visitWithScope still
    // emits variables regardless of `contextual`).
    visitWithScope(head, emit, scoped, contextual);
    for (let i = 1; i < steps.length; i++) {
      visitWithScope(steps[i], emit, scoped, true);
    }
    // Walk any non-`steps` children (e.g. a predicate hung off the
    // path node itself) under the normal rules.
    for (const [k, v] of Object.entries(ast)) {
      if (k === "type" || k === "value" || k === "position" || k === "steps") continue;
      visitWithScope(v, emit, scoped, contextual || CONTEXTUAL_AST_KEYS.has(k));
    }
    return;
  }
  if (ast.type === "variable" && typeof ast.value === "string") {
    const id = `$${ast.value}`;
    if (!scoped.has(id)) emit(id);
  }
  for (const [k, v] of Object.entries(ast)) {
    if (k === "type" || k === "value" || k === "position") continue;
    // Descending into a filter/sort/group sub-expression flips on
    // contextual mode for the whole sub-tree.
    visitWithScope(v, emit, scoped, contextual || CONTEXTUAL_AST_KEYS.has(k));
  }
}

// Jsonata built-ins that appear as `$fn(...)` — must not be flagged.
const JSONATA_BUILTINS = new Set([
  "$",
  "$$",
  "$sum",
  "$count",
  "$max",
  "$min",
  "$average",
  "$string",
  "$number",
  "$boolean",
  "$not",
  "$exists",
  "$length",
  "$substring",
  "$substringBefore",
  "$substringAfter",
  "$uppercase",
  "$lowercase",
  "$trim",
  "$pad",
  "$contains",
  "$split",
  "$join",
  "$match",
  "$replace",
  "$eval",
  "$now",
  "$millis",
  "$fromMillis",
  "$toMillis",
  "$keys",
  "$lookup",
  "$spread",
  "$merge",
  "$map",
  "$filter",
  "$reduce",
  "$sift",
  "$each",
  "$sort",
  "$reverse",
  "$shuffle",
  "$distinct",
  "$zip",
  "$append",
  "$round",
  "$floor",
  "$ceil",
  "$abs",
  "$power",
  "$sqrt",
  "$random",
  "$formatNumber",
  "$formatBase",
  "$formatInteger",
  "$parseInteger",
  "$type",
  "$error",
  "$assert",
  "$base64encode",
  "$base64decode",
  "$encodeUrlComponent",
  "$decodeUrlComponent",
  "$encodeUrl",
  "$decodeUrl",
]);

/** Damerau-Levenshtein-style distance, capped to a short threshold so
 *  the "did you mean" suggestion only fires for near-misses (single typo,
 *  case difference, missing prefix). Anything farther than the cap is
 *  rejected — random unrelated names should not produce a suggestion. */
function shortDistance(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    dp[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j - 1] ?? Infinity, dp[j] ?? Infinity);
      prev = tmp ?? 0;
      if ((dp[j] ?? Infinity) < rowMin) rowMin = dp[j] ?? Infinity;
    }
    if (rowMin > cap) return cap + 1;
  }
  return dp[n] ?? cap + 1;
}

/** Best-match suggestion for an unresolved identifier given the actual
 *  in-scope keys. Returns null when no in-scope key is close enough —
 *  better to say nothing than mislead the LLM with a bogus path. */
function bestSuggestion(unresolved: string, available: string[]): string | null {
  let best: { id: string; dist: number } | null = null;
  for (const candidate of available) {
    // Skip $-prefixed builtins as suggestions for plain identifiers and
    // vice versa; they're not interchangeable.
    if (unresolved.startsWith("$") !== candidate.startsWith("$")) continue;
    const dist = shortDistance(unresolved, candidate, 3);
    if (dist > 3) continue;
    if (!best || dist < best.dist) best = { id: candidate, dist };
  }
  return best?.id ?? null;
}

function detectUnresolvedIdentifiers(
  expression: string,
  scope: Record<string, unknown>,
  bindings: Record<string, unknown>,
): StepWarning[] {
  const ast = extractAst(expression) as AstNode | null;
  if (!ast) return [];
  const known = new Set<string>();
  for (const k of Object.keys(scope)) known.add(k);
  for (const k of Object.keys(bindings)) known.add(`$${k}`);
  // `$` is the context item; always valid.
  known.add("$");
  // jsonata exposes bound names as `$name`; also accept the bare name.
  for (const k of Object.keys(bindings)) known.add(k);

  const unresolved = new Set<string>();
  visitRootIdentifiers(ast, (id) => {
    if (!id) return;
    if (id.startsWith("$") && JSONATA_BUILTINS.has(id)) return;
    if (known.has(id)) return;
    unresolved.add(id);
  });
  // Build available_paths for the warning details. For each scope entry
  // we expose two canonical access shapes the LLM commonly needs:
  //   1. `<key>` — the envelope itself
  //   2. `<key>.data` — the payload (the most-frequently-referenced path)
  // Plus all `$name` bindings. Listed once so the LLM can cite them
  // directly instead of guessing which JSONata path is in scope.
  const availablePaths: string[] = [];
  for (const k of Object.keys(scope)) {
    availablePaths.push(k);
    const env = scope[k] as { data?: unknown } | null | undefined;
    if (env && typeof env === "object" && "data" in env) {
      availablePaths.push(`${k}.data`);
    }
  }
  for (const k of Object.keys(bindings)) availablePaths.push(`$${k}`);
  return [...unresolved].map((identifier) => {
    const suggestion = bestSuggestion(identifier, [...known]);
    return {
      code: "unresolved_identifier" as const,
      identifier,
      message: `jsonata expression referenced "${identifier}" but no matching key was in scope or bindings`,
      details: {
        // Sorted so the warning is byte-stable across runs (determinism).
        available_paths: availablePaths.slice().sort(),
        ...(suggestion ? { suggestion } : {}),
      },
    };
  });
}

export async function runTransformStep(p: RunTransformParams): Promise<StepResult> {
  const start = Date.now();
  const timeoutMs = p.step.timeout_ms ?? TRANSFORM_TIMEOUT_DEFAULT_MS;
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort("timeout"), timeoutMs);
  const signal = combineSignals([p.ctx.signal, timeoutCtrl.signal]);
  const language = p.step.language ?? "jsonata";
  // Web-scraper #144 — three of the supported languages are dispatched
  // elsewhere; only `jsonata` / `javascript` need `expression` here. The
  // schema superRefine enforces this contract at authoring time; the
  // guard below is defence-in-depth for callers that bypass the parser.
  if ((language === "jsonata" || language === "javascript") && !p.step.expression) {
    return {
      status: "failed",
      error: {
        code: "transform_error",
        message: `transform.language=${language} requires a non-empty expression`,
      },
      retry_count: 0,
      duration_ms: Date.now() - start,
    };
  }
  // Web-scraper #144 — three static-import branches that operate on the
  // upstream HTML body and emit a typed JSON envelope. These do not race
  // against the abort signal because each is synchronous and bounded by
  // its own max_chars cap.
  if (language === "readability") {
    clearTimeout(timer);
    return runReadability({ ctx: p.ctx, step: p.step, input: p.input });
  }
  if (language === "html-to-markdown") {
    clearTimeout(timer);
    return runHtmlToMarkdown({ ctx: p.ctx, step: p.step, input: p.input });
  }
  if (language === "structured-data") {
    clearTimeout(timer);
    return runStructuredData({ ctx: p.ctx, step: p.step, input: p.input });
  }
  try {
    if (language === "javascript") {
      // QuickJS already enforces its own wall-clock safety net — we
      // pass the step timeout as `wall_ms` and race against the same
      // abort signal so external cancels still land.
      const jsPromise = runJs({
        code: p.step.expression as string,
        input: { scope: p.scope, input: p.input },
        limits: { wall_ms: timeoutMs },
      });
      const raced = await Promise.race([
        jsPromise,
        new Promise((_, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ]);
      return {
        status: "succeeded",
        output: (raced as { output: unknown }).output,
        retry_count: 0,
        duration_ms: Date.now() - start,
      };
    }
    const expr = compileJsonata(p.step.expression as string);
    // Bindings available inside the expression:
    //   $input     — the execution input (same object the workflow was
    //                invoked with).
    //   $scope     — the full step-output scope. `$scope.fetch_repos` is
    //                the same as the bare path `fetch_repos`.
    //   $steps     — alias of $scope. Some authors prefer the name
    //                "$steps.id.field" because it reads more clearly.
    //   $step_meta — per-step metadata (status_code, duration_ms, url,
    //                method, bytes_in for request steps; duration_ms +
    //                retry_count for every step). Accessed as
    //                `$step_meta.fetch_repos.status_code`.
    //   $<key>     — every `$`-prefixed key on scope (e.g. `$loop_index`)
    //                is unpacked. Plain (non-`$`) keys remain
    //                addressable as bare path expressions against the
    //                root context object.
    const bindings = buildJsonataBindings(p.scope, p.input);
    const parseTimeWarnings = detectUnresolvedIdentifiers(
      p.step.expression as string,
      p.scope,
      bindings,
    );
    // race jsonata.evaluate against the abort signal
    const evalPromise = expr.evaluate(p.scope, bindings);
    const result = await Promise.race([
      evalPromise,
      new Promise((_, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);
    // Suppress parse-time `unresolved_identifier` warnings ONLY for
    // the projection-iteration case where the LLM wrote a path like
    // `fetch_projects.data.{ 'id': id, 'name': name }`. Inside that
    // projection, `id`/`name` are implicit context-step paths against
    // the iterator — valid at runtime, but the AST walker can't prove
    // it statically. The signal that this case applied: the result is
    // a non-empty array (the projection produced one record per
    // iteration). Top-level object constructors like
    // `{ "city": ..., "date": data.daily.time[1] }` (the "Berlin bug"
    // shape) keep their warnings because a bare `data` there is a
    // genuinely unresolved root identifier and the result happens to
    // be an object, not an iteration array. The transform_empty_extraction
    // detector below catches the dual case where the bare identifier
    // DIDN'T resolve and the projection produced nothing.
    const resultIsNonEmptyArray = Array.isArray(result) && (result as unknown[]).length > 0;
    const warnings = resultIsNonEmptyArray
      ? parseTimeWarnings.filter((w) => w.code !== "unresolved_identifier")
      : [...parseTimeWarnings];
    // Empty-extraction detector. Catches "JSONata produced []
    // from a scope that contained data" — the silent failure mode
    // observed in session a6440493 where the loop body succeeded with
    // droplets but the post-loop projection extracted nothing because
    // the path was wrong. This is heuristic (a legitimate filter that
    // matches nothing also produces []) so we tag the warning as
    // informational; the run_workflow lifecycle promotes it to
    // requires_repair when paired with non-empty source data, which
    // the commit gate then refuses without force_commit.
    const isEmptyResult =
      result === undefined ||
      result === null ||
      (Array.isArray(result) && (result as unknown[]).length === 0);
    let scopeHadData = false;
    if (isEmptyResult) {
      for (const v of Object.values(p.scope)) {
        const env = v as { data?: unknown } | null | undefined;
        if (!env || typeof env !== "object") continue;
        const data = env.data;
        if (Array.isArray(data) && data.length > 0) {
          scopeHadData = true;
          break;
        }
        if (data && typeof data === "object" && Object.keys(data as object).length > 0) {
          scopeHadData = true;
          break;
        }
      }
    }
    if (isEmptyResult && scopeHadData) {
      // did_you_mean post-processing — same shape as
      // loop_over_unresolved / branch_when_unresolved. Walk the
      // expression for $scope/$steps/${scope.X} refs, cross-check
      // against the actual scope keys, and surface Levenshtein
      // matches. Pre-fix the LLM had to guess from "available_scope_keys"
      // alone; with did_you_mean it can copy the suggested step id
      // directly into the next attempt.
      const referenced = extractStepIdReferences(p.step.expression ?? "");
      const scopeKeys = Object.keys(p.scope).filter((k) => !k.startsWith("$"));
      const didYouMean: Array<{ from: string; to: string[] }> = [];
      for (const ref of referenced) {
        if (!scopeKeys.includes(ref)) {
          const matches = suggestClosest(ref, scopeKeys, 3);
          if (matches.length > 0) didYouMean.push({ from: ref, to: matches });
        }
      }
      const dymHint =
        didYouMean.length > 0
          ? ` Did you mean ${didYouMean
              .map((d) => `\`${d.to[0]}\` (closest match for \`${d.from}\`)`)
              .join(", ")}? `
          : "";
      // Real-path enrichment. The step-id `did_you_mean` above only
      // helps when the step id itself was wrong. The far more common
      // empty-extraction cause is a correct step id with a wrong NESTED
      // path — e.g. `$scope.fetch.data.chargers` when the payload is
      // actually at `$scope.fetch.data.data.chargers.edges`. Pre-fix the
      // warning just said "likely referenced the wrong path" with no
      // path to copy, and the authoring agent guessed for a dozen
      // turns. Here we walk the ACTUAL upstream envelope payload and
      // surface concrete, copy-paste `$scope.<step>.data.<path>`
      // candidates — the same data `suggest_jsonata_paths` would
      // return, delivered inline on the warning.
      const availablePaths: string[] = [];
      for (const ref of referenced) {
        if (!scopeKeys.includes(ref)) continue;
        const env = p.scope[ref] as { data?: unknown } | null | undefined;
        if (!env || typeof env !== "object") continue;
        const payload = env.data;
        if (payload === null || payload === undefined) continue;
        // Container paths only — drop concrete array indices (`[0]`) and
        // the `[*]` documentation marker. The agent should project with
        // JSONata fanout (`edges.node`), not a literal index.
        const rels = enumerateScopePaths(payload, { path_budget: 60 }).filter(
          (rel) => !/\[\d+\]|\[\*\]/.test(rel),
        );
        rels.sort((a, b) => a.length - b.length);
        for (const rel of rels.slice(0, 8)) {
          availablePaths.push(rel ? `$scope.${ref}.data.${rel}` : `$scope.${ref}.data`);
        }
      }
      const pathHint =
        availablePaths.length > 0
          ? ` The referenced upstream step exposes these real paths — copy one verbatim: ${availablePaths
              .slice(0, 12)
              .map((pp) => `\`${pp}\``)
              .join(", ")}.`
          : "";
      warnings.push({
        code: "transform_empty_extraction" as const,
        identifier: p.step.id,
        message: `transform "${p.step.id}" produced an empty result, but upstream scope had non-empty data — the JSONata expression referenced a path that does not resolve.${dymHint}${pathHint} Or run dry_run_transform with the actual scope to inspect.`,
        details: {
          step_key: p.step.id,
          available_scope_keys: Object.keys(p.scope),
          ...(didYouMean.length > 0 ? { did_you_mean: didYouMean } : {}),
          ...(availablePaths.length > 0 ? { available_paths: availablePaths } : {}),
        },
      });
    }
    // Dropped-fields detector. When the transform produces an array of
    // objects (a $map over loop output, the dominant aggregate
    // pattern) AND there exists a non-empty source array in scope
    // whose iteration objects carry MORE keys than the result
    // objects, the projection silently dropped fields. Pre-fix this
    // was exactly session 3f6082d2's symptom: format_output mapped
    // over project_loop.data and emitted {project_id, project_name}
    // only — the body step keys (extract, fetch_resources) were
    // dropped. The LLM then wrote v2/v3 chasing the same bug because
    // there was no signal pointing at the missing keys.
    // Per-step opt-out for transforms whose authors have consciously
    // acknowledged the projection. The detector's heuristics still fire
    // by default — opt out via `silence_warnings: ["dropped_fields"]`
    // when the omission is intentional (e.g. session f00b8d1c style
    // derived projections that rename source keys wholesale).
    const silenceWarnings = Array.isArray(
      (p.step as { silence_warnings?: unknown }).silence_warnings,
    )
      ? ((p.step as { silence_warnings: unknown[] }).silence_warnings as unknown[])
      : [];
    const droppedFieldsSilenced = silenceWarnings.includes("dropped_fields");
    if (
      !droppedFieldsSilenced &&
      Array.isArray(result) &&
      (result as unknown[]).length > 0 &&
      typeof (result as unknown[])[0] === "object" &&
      (result as unknown[])[0] !== null &&
      !Array.isArray((result as unknown[])[0])
    ) {
      const resultKeys = new Set(Object.keys((result as Array<Record<string, unknown>>)[0] ?? {}));
      // Walk the scope for the most likely source array — any value
      // whose `.data` is a non-empty array of objects whose first
      // element has >= 2 keys (single-key arrays like [{ id }] are
      // legit projections, not dropped-field cases).
      for (const [scopeKey, value] of Object.entries(p.scope)) {
        const env = value as { data?: unknown } | null | undefined;
        if (!env || typeof env !== "object") continue;
        const data = env.data;
        if (!Array.isArray(data) || data.length === 0) continue;
        const first = data[0] as Record<string, unknown> | null;
        if (!first || typeof first !== "object" || Array.isArray(first)) continue;
        const sourceKeys = new Set(Object.keys(first));
        if (sourceKeys.size < 2) continue;
        const droppedKeys: string[] = [];
        for (const k of sourceKeys) {
          if (!resultKeys.has(k)) droppedKeys.push(k);
        }
        // Heuristic threshold: only flag when more than half the
        // source keys vanished. A projection that explicitly renames
        // (e.g. id → project_id) legitimately drops the original
        // names, but you typically rename a small subset. Wholesale
        // dropping (here: 2/3 of body step keys gone) is the
        // pathology.
        if (droppedKeys.length >= 2 && droppedKeys.length >= sourceKeys.size / 2) {
          warnings.push({
            code: "transform_dropped_fields" as const,
            identifier: p.step.id,
            message: `transform "${p.step.id}" produced ${(result as unknown[]).length} objects with keys [${[...resultKeys].join(", ")}] but the source iteration "${scopeKey}.data[0]" had keys [${[...sourceKeys].join(", ")}] — the projection likely dropped fields. Use inspect_execution_step on the prior run to see the real source shape, then re-author. Suppress with \`silence_warnings: ["dropped_fields"]\` on the step when the omission is intentional.`,
            details: {
              step_key: p.step.id,
              source_scope_key: scopeKey,
              result_keys: [...resultKeys],
              source_keys: [...sourceKeys],
              dropped_keys: droppedKeys,
            },
          });
          break;
        }
      }
    }
    const out: StepResult = {
      status: "succeeded",
      output: result,
      retry_count: 0,
      duration_ms: Date.now() - start,
    };
    if (warnings.length > 0) {
      out.warnings = warnings;
      // Log the warning CODES, not the identifier. Pre-fix the
      // identifier carried the step id (because `identifier` is
      // populated as the offending step on parse-time warnings),
      // so the log read like `warnings: ["format_output"]` instead
      // of `warnings: ["transform_dropped_fields"]` — masking the
      // actual diagnostic class.
      logger.info({
        module: "execution",
        action: "step.transform.warnings",
        step_id: p.step.id,
        warnings: warnings.map((w) => w.code),
        identifiers: warnings.map((w) => w.identifier).filter(Boolean),
      });
    }
    return out;
  } catch (err) {
    const duration_ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof SandboxTimeoutError || err instanceof SandboxInterruptError) {
      logger.warn({
        module: "execution",
        action: "step.transform.timeout",
        step_id: p.step.id,
        language,
        timeout_ms: timeoutMs,
        duration_ms,
      });
      return {
        status: "timed_out",
        retry_count: 0,
        duration_ms,
        error: { code: "transform_timeout", message: `transform exceeded ${timeoutMs}ms` },
      };
    }
    if (err instanceof SandboxMemoryError) {
      logger.warn({
        module: "execution",
        action: "step.transform.memory_error",
        step_id: p.step.id,
        language,
        duration_ms,
        error: message,
      });
      return {
        status: "failed",
        retry_count: 0,
        duration_ms,
        error: { code: "transform_memory", message },
      };
    }
    if (timeoutCtrl.signal.aborted && !p.ctx.signal.aborted) {
      logger.warn({
        module: "execution",
        action: "step.transform.timeout",
        step_id: p.step.id,
        language,
        timeout_ms: timeoutMs,
        duration_ms,
      });
      return {
        status: "timed_out",
        retry_count: 0,
        duration_ms,
        error: { code: "transform_timeout", message: `transform exceeded ${timeoutMs}ms` },
      };
    }
    if (p.ctx.signal.aborted) {
      return {
        status: "aborted",
        retry_count: 0,
        duration_ms,
        error: { code: "aborted", message: "execution aborted" },
      };
    }
    logger.warn({
      module: "execution",
      action: "step.transform.error",
      step_id: p.step.id,
      language,
      duration_ms,
      error: message,
    });
    return {
      status: "failed",
      retry_count: 0,
      duration_ms,
      error: buildStepErrorDetail({ code: "transform_error", err, message }),
    };
  } finally {
    clearTimeout(timer);
  }
}
