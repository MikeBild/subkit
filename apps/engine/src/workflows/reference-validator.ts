// Authoring-time validator for cross-step references inside JSONata
// expressions and placeholder strings. Refuses a draft that points
// `loop.over`, `branch.when`, `transform.expression`, or any
// `${scope.<id>...}` placeholder at a step id that doesn't exist in
// the workflow's `steps[]`.
//
// Pre-fix the LLM could author `over: "$scope.wrong_step.data"` and
// only discover the typo at runtime via the `loop_over_unresolved`
// warning — burning at minimum one full dry-run cycle. This catches
// every form at draft-write time so the LLM gets a structured Zod-
// shaped error before the run.
//
// Bare-path forms (`<step_id>.<field>`) are also flagged when the
// leading identifier looks like a step reference and matches no
// known step id or built-in. The skill explicitly documents
// `<step_id>.data` as equivalent to `$scope.<step_id>.data`, so the
// LLM uses that form ~half the time.
//
// Pure data — no I/O. Used by build_workflow / propose_step /
// update_param / edit_workflow_patch / dry_run_workflow pre-flights
// and `output_transform` / `output_transform_function` validation.

import { findUnsupportedPlaceholders } from "../llm/substitution/unsupported.ts";
import { findBareItemRefs, rewriteBareItemRefs } from "./itemvar-rewrite.ts";
import { levenshtein, suggestClosest } from "./levenshtein.ts";
import type { WorkflowDef } from "./types.ts";

/** Range of characters covered by a string literal. */
interface Span {
  start: number;
  end: number;
}

/** Walks a piece of source text and records the byte-spans of every
 *  `'…'` and `"…"` string literal. Backslash escapes are honoured.
 *  Used to suppress bare-path validation inside string literals — the
 *  validator's regex would otherwise flag `mikebild.com` or
 *  `application.json` as candidate step references. */
function computeStringLiteralSpans(text: string): Span[] {
  const out: Span[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text.charCodeAt(i);
    if (ch === 0x27 /* ' */ || ch === 0x22 /* " */) {
      const quote = ch;
      const start = i;
      i++;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 0x5c /* \ */ && i + 1 < n) {
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          out.push({ start, end: i });
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return out;
}

function insideAnySpan(idx: number, spans: ReadonlyArray<Span>): boolean {
  for (const s of spans) {
    if (idx >= s.start && idx < s.end) return true;
  }
  return false;
}

export interface ReferenceValidationError {
  step_id: string;
  field: string;
  /** The unrecognised step id the expression / placeholder named. */
  bad_reference: string;
  /** The full expression / placeholder text where it appeared. */
  context: string;
  /** Up to 3 closest matches by Levenshtein distance. */
  did_you_mean: string[];
}

/**
 * One unsupported placeholder found in a draft string (Mustache, bad
 * kind, or `${$loop...}` / `${$item...}` aliases). Carries a concrete
 * rewrite the LLM can paste into the next propose_step / build_workflow
 * call.
 *
 * Surfaced by `validateUnsupportedPlaceholders()` and threaded through
 * the same error envelope as `validateStepReferences()`. The reason this
 * is its own type and not a `ReferenceValidationError` variant is that
 * the LLM needs to see them as distinct codes so the self-healing
 * proposer can target Mustache → `${item.X}` rewrites without confusing
 * them with step-id typos.
 */
export interface UnsupportedPlaceholderError {
  step_id: string;
  field: string;
  /** The literal substring the author wrote (e.g. `{{ $item.id }}`). */
  raw: string;
  /** Concrete rewrite suggestion. */
  did_you_mean: string;
  /** Discriminator from the detector: `mustache` / `bad_kind` / `loop_alias` / `item_alias`. */
  code: string;
  /** Human-readable explanation surfaced to the LLM. */
  message: string;
}

const SCOPE_PLACEHOLDER_RE = /\$\{\s*scope\.([a-zA-Z_][\w-]*)/g;
const JSONATA_SCOPE_RE = /\$scope\.([a-zA-Z_][\w-]*)/g;
const JSONATA_STEPS_RE = /\$steps\.([a-zA-Z_][\w-]*)/g;
// Bare-path: an identifier at the start of a path that's followed
// by a dot. Excludes `$`-prefixed builtins (those are caught by the
// JSONata scope/steps regex above) and excludes anything that's
// part of a string literal context (best-effort — we accept some
// false positives because the candidate list filters them out).
const BARE_PATH_RE = /(?:^|[^\w$.])([a-zA-Z_][\w]*)\./g;
// JS-arg scope access for output_transform_function /
// loop.data_selector: `scope.<X>` / `sourceData.<X>`. The argument
// is the runtime scope object, so the leading identifier after the
// dot is the step id.
const JS_SCOPE_ACCESS_RE = /(?:^|[^\w$.])(?:scope|sourceData)\.([a-zA-Z_][\w]*)/g;

/** JSONata built-ins + author-facing bindings that legitimately
 * appear at the start of a bare path. Bare-path validation skips
 * these.
 *
 * The list also covers HTTP/REST response shape vocabulary
 * (`links.self`, `meta.total`, `data.items`, `headers.Content-Type`,
 * etc.). Pre-fix the bare-path regex flagged any of these as
 * "unknown step id" and the LLM rewrote correct transforms to make
 * the false positive go away. Session f00b8d1c hit this on
 * `links.self` in HATEOAS resource expansion. */
const RESERVED_BARE_IDENTIFIERS = new Set([
  "input",
  "scope",
  "steps",
  "item",
  "loop_index",
  "this",
  "now",
  "null",
  "true",
  "false",
  "Math",
  "Number",
  "String",
  "Array",
  "Object",
  "Date",
  "JSON",
  // common JSONata function-arg names that show up in `$map(arr,
  // function($iter, $i) {...})` patterns.
  "iter",
  "i",
  "value",
  "v",
  // HTTP/REST response shape vocabulary that authors compose freely
  // inside JSONata projection expressions. Each name is a valid
  // top-level key on data the engine returns and every one of these
  // could surface as `<name>.<sub>` in author code without being a
  // step reference.
  "links",
  "meta",
  "data",
  "error",
  "errors",
  "result",
  "results",
  "response",
  "request",
  "params",
  "query",
  "body",
  "headers",
  "status",
  "code",
  "message",
  "page",
  "pages",
  "items",
  "edges",
  "nodes",
  "next",
  "prev",
  "first",
  "last",
  "self",
  "current",
  "currentItem",
  "details",
  "metadata",
  "id",
  "ids",
  "name",
  "type",
  "kind",
  "attributes",
  "relationships",
  "included",
]);

function suggest(target: string, candidates: ReadonlyArray<string>): string[] {
  return suggestClosest(target, candidates, 3);
}

/**
 * Run the explicit `$scope.X` / `$steps.X` / `${scope.X}` checks.
 * Used by every site (per-step typed fields + generic string walk).
 */
function collectReferences(
  text: string,
  knownIds: ReadonlySet<string>,
  emitOffender: (badRef: string) => void,
): void {
  for (const re of [SCOPE_PLACEHOLDER_RE, JSONATA_SCOPE_RE, JSONATA_STEPS_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const ref = m[1] ?? "";
      if (ref && !knownIds.has(ref)) emitOffender(ref);
    }
  }
}

/**
 * Bare-path pass. Only safe to run on JSONata expression sites
 * (transform.expression, loop.over, loop.data_selector, branch.when,
 * output_transform). URLs, header values, body strings legitimately
 * contain dotted identifiers that aren't step refs (`example.com`,
 * `application.json`), so we never run this pass against arbitrary
 * config strings.
 *
 * Tightening rules:
 *   - Skip identifiers already caught by `$scope.X` / `$steps.X` /
 *     `${scope.X}` (would double-report).
 *   - Skip RESERVED_BARE_IDENTIFIERS (input/scope/steps + JSONata
 *     binding conventions).
 *   - Require snake_case-ish (lowercase with optional underscores).
 *     Step ids in the wild follow this; CamelCase identifiers are
 *     usually JS / JSONata constructor refs.
 *   - Require length >= 3 to skip short lambda args.
 */
function collectBarePathReferences(
  text: string,
  knownIds: ReadonlySet<string>,
  emitOffender: (badRef: string) => void,
): void {
  const explicit = new Set<string>();
  for (const re of [SCOPE_PLACEHOLDER_RE, JSONATA_SCOPE_RE, JSONATA_STEPS_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const ref = m[1] ?? "";
      if (ref) explicit.add(ref);
    }
  }
  // Pre-compute string-literal spans so the bare-path scan skips
  // anything inside `'...'` or `"..."`. Pre-fix the validator flagged
  // domain names (`mikebild.com`, `codecommission.de`) and content-
  // type strings (`application/json`) when they appeared inside string
  // literals in JSONata expressions. Author code routinely contains
  // these and they are not step references.
  const stringSpans = computeStringLiteralSpans(text);
  BARE_PATH_RE.lastIndex = 0;
  for (let bm = BARE_PATH_RE.exec(text); bm !== null; bm = BARE_PATH_RE.exec(text)) {
    const ref = bm[1] ?? "";
    if (!ref) continue;
    if (RESERVED_BARE_IDENTIFIERS.has(ref)) continue;
    if (explicit.has(ref)) continue;
    if (knownIds.has(ref)) continue;
    if (!/^[a-z][a-z0-9_]*$/.test(ref)) continue;
    if (ref.length < 3) continue;
    // Skip identifiers that fall inside a string literal.
    const matchStart = bm.index;
    if (insideAnySpan(matchStart, stringSpans)) continue;
    // Last-mile filter: only flag identifiers that look like step-id
    // typos. If no known step id is within Levenshtein distance 2, the
    // identifier is almost certainly not a step reference (e.g. a
    // domain like `unknownexample.org` whose head doesn't resemble any
    // step). This eliminates a class of false positives the reserved
    // list cannot enumerate.
    if (knownIds.size === 0) continue;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const id of knownIds) {
      const d = levenshtein(ref.toLowerCase(), id.toLowerCase());
      if (d < nearestDistance) nearestDistance = d;
      if (nearestDistance <= 2) break;
    }
    if (nearestDistance > 2) continue;
    emitOffender(ref);
  }
  // JS-arg scope access — `scope.<X>` / `sourceData.<X>`. Any
  // captured X that isn't a known step id is a typo. Length check
  // is more permissive here because the JS form is unambiguous.
  JS_SCOPE_ACCESS_RE.lastIndex = 0;
  for (let jm = JS_SCOPE_ACCESS_RE.exec(text); jm !== null; jm = JS_SCOPE_ACCESS_RE.exec(text)) {
    const ref = jm[1] ?? "";
    if (!ref) continue;
    if (knownIds.has(ref)) continue;
    if (RESERVED_BARE_IDENTIFIERS.has(ref)) continue;
    emitOffender(ref);
  }
}

function walkStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walkStrings(v, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) walkStrings(v, visit);
  }
}

/**
 * Walk every JSONata expression / placeholder string on every step
 * in the draft and check that referenced step ids exist. Returns an
 * array of structured errors — empty array means "all references
 * resolve."
 */
export function validateStepReferences(def: WorkflowDef): ReferenceValidationError[] {
  const stepIds = new Set(def.steps.map((s) => s.id));
  const allIds = [...stepIds];
  const errors: ReferenceValidationError[] = [];

  const emit = (step_id: string, field: string, badRef: string, context: string): void => {
    errors.push({
      step_id,
      field,
      bad_reference: badRef,
      context,
      did_you_mean: suggest(badRef, allIds),
    });
  };

  for (const step of def.steps) {
    // Loop / branch / transform have their own JSONata fields. Walk
    // each typed location explicitly so the error's `field` value is
    // accurate.
    if (step.kind === "loop") {
      const loop = step as { over?: string; data_selector?: string };
      const over = loop.over;
      if (over) {
        collectReferences(over, stepIds, (ref) => emit(step.id, "over", ref, over));
        collectBarePathReferences(over, stepIds, (ref) => emit(step.id, "over", ref, over));
      }
      const data_selector = loop.data_selector;
      if (data_selector) {
        collectReferences(data_selector, stepIds, (ref) =>
          emit(step.id, "data_selector", ref, data_selector),
        );
        collectBarePathReferences(data_selector, stepIds, (ref) =>
          emit(step.id, "data_selector", ref, data_selector),
        );
      }
      continue;
    }
    if (step.kind === "branch") {
      const when = (step as { when?: string }).when;
      if (when) {
        collectReferences(when, stepIds, (ref) => emit(step.id, "when", ref, when));
        collectBarePathReferences(when, stepIds, (ref) => emit(step.id, "when", ref, when));
      }
      continue;
    }
    if (step.kind === "transform") {
      const expression = (step as { expression?: string }).expression;
      if (expression) {
        collectReferences(expression, stepIds, (ref) =>
          emit(step.id, "expression", ref, expression),
        );
        collectBarePathReferences(expression, stepIds, (ref) =>
          emit(step.id, "expression", ref, expression),
        );
      }
      continue;
    }
    // Generic: walk every string property on the step config (path,
    // url, body, query, headers, …). Catches ${scope.X.…} in HTTP
    // request templates.
    walkStrings(step, (s) => {
      collectReferences(s, stepIds, (ref) => {
        // We don't know the exact field path for arbitrary string
        // walks; tag with `*` so the LLM still sees which step the
        // bad reference came from.
        emit(step.id, "*", ref, s.length > 120 ? `${s.slice(0, 120)}…` : s);
      });
    });
  }

  // Workflow-level output_transform / output_transform_function.
  // The expression reads `$scope.<step>.data` to produce the final
  // workflow output; a typo here silently drops fields just like a
  // per-step transform does. Tagged with the synthetic step_id
  // `(output_transform)` so the LLM can disambiguate.
  const outputTransform = (def as { output_transform?: unknown }).output_transform;
  if (typeof outputTransform === "string" && outputTransform.length > 0) {
    collectReferences(outputTransform, stepIds, (ref) =>
      emit("(output_transform)", "output_transform", ref, outputTransform),
    );
    collectBarePathReferences(outputTransform, stepIds, (ref) =>
      emit("(output_transform)", "output_transform", ref, outputTransform),
    );
  }
  const outputTransformFn = (def as { output_transform_function?: unknown })
    .output_transform_function;
  if (typeof outputTransformFn === "string" && outputTransformFn.length > 0) {
    collectReferences(outputTransformFn, stepIds, (ref) =>
      emit("(output_transform_function)", "output_transform_function", ref, outputTransformFn),
    );
    collectBarePathReferences(outputTransformFn, stepIds, (ref) =>
      emit("(output_transform_function)", "output_transform_function", ref, outputTransformFn),
    );
  }

  return errors;
}

/**
 * Bare-iteration-identifier lint (item_var retirement). Inside a loop
 * body, JSONata must address the current item as `$item` — the bare
 * `item` default and the legacy declared `item_var` name are no longer
 * bound for new definitions (see `execution/loop-scope.ts`). This pass
 * walks every loop's body steps' JSONata sites (`transform.expression`,
 * `branch.when`, nested loop `over`) on the parsed AST and flags
 * root-context bare references to:
 *
 *   - `item` (the retired schema default), and
 *   - the enclosing loop's declared `item_var` (legacy form being
 *     re-authored — `validateWorkflowDef` already rejects the
 *     declaration itself; this lint adds the concrete rewrite).
 *
 * `did_you_mean` carries the full `$item`-rewritten expression when the
 * AST rewriter can prove the rewrite, else the `$item` binding name —
 * same plumbing the step-reference errors use, so the LLM can paste
 * the suggestion directly.
 *
 * Steps are accepted structurally (Record<string, unknown>) so the
 * conversations verifier can call this on a raw draft before the Zod
 * parse.
 */
export function validateBareIterationIdentifiers(
  steps: ReadonlyArray<Record<string, unknown>>,
): ReferenceValidationError[] {
  const errors: ReferenceValidationError[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const s of steps) {
    if (typeof s.id === "string") byId.set(s.id, s);
  }
  // step_id → innermost enclosing loop step.
  const parentLoop = new Map<string, Record<string, unknown>>();
  for (const s of steps) {
    if (s.kind !== "loop" || !Array.isArray(s.body)) continue;
    for (const bodyId of s.body) {
      if (typeof bodyId === "string" && !parentLoop.has(bodyId)) parentLoop.set(bodyId, s);
    }
  }

  const jsonataSite = (step: Record<string, unknown>): { field: string; text: string } | null => {
    if (step.kind === "transform") {
      // The bare-`item` lint is a JSONata-only AST check. Transforms are
      // JavaScript (default), and a JS body addresses the loop item through
      // its own scope, not a bare JSONata `item` reference — so transform
      // expressions are never linted here. JSONata bare-item linting still
      // applies to the `branch.when` and `loop.over` slots below.
      return null;
    }
    if (step.kind === "branch" && typeof step.when === "string" && step.when) {
      return { field: "when", text: step.when };
    }
    if (step.kind === "loop" && typeof step.over === "string" && step.over) {
      return { field: "over", text: step.over };
    }
    return null;
  };

  for (const step of steps) {
    const id = typeof step.id === "string" ? step.id : null;
    if (!id) continue;
    const loop = parentLoop.get(id);
    if (!loop) continue;
    const site = jsonataSite(step);
    if (!site) continue;
    const names = new Set<string>(["item"]);
    if (typeof loop.item_var === "string" && loop.item_var.length > 0) names.add(loop.item_var);
    const found = findBareItemRefs(site.text, names);
    if (!found.ok) continue; // unparseable / shadowed — other validators own those
    const referenced = [...new Set(found.refs.map((r) => r.name))];
    for (const name of referenced) {
      const rewrite = rewriteBareItemRefs(site.text, name);
      errors.push({
        step_id: id,
        field: site.field,
        bad_reference: name,
        context: site.text,
        did_you_mean: [rewrite.ok && rewrite.changed ? rewrite.rewritten : "$item"],
      });
    }
  }

  // `for_each` inline-iteration lint. A step that declares `for_each`
  // (a JS selector body returning an array) must reference `$item` or
  // `${item.…}` somewhere in its own definition — otherwise the iteration
  // runs N copies of the same call, exactly the bug the loop-body check
  // targets. The check mirrors the loop body reference rule
  // (`validateWorkflowDef` lines 311-319) but applies to the step itself
  // rather than to an enclosing loop wrapper.
  const ITEM_REF_RE = /\$item\b|\$\{item[.[]/;
  for (const step of steps) {
    const id = typeof step.id === "string" ? step.id : null;
    if (!id) continue;
    if (typeof step.for_each !== "string" || step.for_each.length === 0) continue;
    const haystack = JSON.stringify(step);
    if (!ITEM_REF_RE.test(haystack)) {
      errors.push({
        step_id: id,
        field: "for_each",
        bad_reference: "(missing)",
        context: step.for_each as string,
        did_you_mean: [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: operator-facing message names the literal `${item.…}` placeholder grammar.
          "$item (use `$item.<field>` in JS expressions or `${item.<field>}` in URL/header/body strings)",
        ],
      });
    }
  }

  return errors;
}

/**
 * Scan every string field on every step for placeholder shapes the
 * runtime won't substitute (Mustache, `${user.X}`, `${$loop...}`, etc.).
 * Returns `[]` when the draft is clean.
 *
 * Called by `build_workflow` (hard-reject) and `propose_step` /
 * `update_param` (warn + suggest).
 */
export function validateUnsupportedPlaceholders(def: WorkflowDef): UnsupportedPlaceholderError[] {
  const errors: UnsupportedPlaceholderError[] = [];

  const visit = (step_id: string, field: string, value: unknown): void => {
    walkStrings(value, (s) => {
      const matches = findUnsupportedPlaceholders(s);
      for (const m of matches) {
        errors.push({
          step_id,
          field,
          raw: m.raw,
          did_you_mean: m.did_you_mean,
          code: m.code,
          message: m.message,
        });
      }
    });
  };

  for (const step of def.steps) {
    if (step.kind === "loop") {
      const loop = step as { over?: string; data_selector?: string };
      if (loop.over) visit(step.id, "over", loop.over);
      if (loop.data_selector) visit(step.id, "data_selector", loop.data_selector);
      continue;
    }
    if (step.kind === "branch") {
      const br = step as { when?: string };
      if (br.when) visit(step.id, "when", br.when);
      continue;
    }
    if (step.kind === "transform") {
      const tx = step as { expression?: string };
      if (tx.expression) visit(step.id, "expression", tx.expression);
      continue;
    }
    // Generic walk — `path`, `url`, `headers`, `query`, `body`, etc.
    visit(step.id, "*", step);
  }

  const outputTransform = (def as { output_transform?: unknown }).output_transform;
  if (typeof outputTransform === "string" && outputTransform.length > 0) {
    visit("(output_transform)", "output_transform", outputTransform);
  }
  const outputTransformFn = (def as { output_transform_function?: unknown })
    .output_transform_function;
  if (typeof outputTransformFn === "string" && outputTransformFn.length > 0) {
    visit("(output_transform_function)", "output_transform_function", outputTransformFn);
  }

  return errors;
}
