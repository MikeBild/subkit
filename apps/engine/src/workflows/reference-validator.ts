import { findUnsupportedPlaceholders } from "../llm/substitution/unsupported.ts";
import { findBareItemRefs, rewriteBareItemRefs } from "./bare-item-refs.ts";
import type { DomainWorkflowDef } from "./domain-types.ts";
import { levenshtein, suggestClosest } from "./levenshtein.ts";

interface Span {
  start: number;
  end: number;
}

function computeStringLiteralSpans(text: string): Span[] {
  const out: Span[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text.charCodeAt(i);
    if (ch === 0x27 || ch === 0x22) {
      const quote = ch;
      const start = i;
      i++;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 0x5c && i + 1 < n) {
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
  bad_reference: string;
  context: string;
  did_you_mean: string[];
}

interface UnsupportedPlaceholderError {
  step_id: string;
  field: string;
  raw: string;
  did_you_mean: string;
  code: string;
  message: string;
}

const SCOPE_PLACEHOLDER_RE = /\$\{\s*scope\.([a-zA-Z_][\w-]*)/g;
const JSONATA_SCOPE_RE = /\$scope\.([a-zA-Z_][\w-]*)/g;
const JSONATA_STEPS_RE = /\$steps\.([a-zA-Z_][\w-]*)/g;
const BARE_PATH_RE = /(?:^|[^\w$.])([a-zA-Z_][\w]*)\./g;
const JS_SCOPE_ACCESS_RE = /(?:^|[^\w$.])(?:scope|sourceData)\.([a-zA-Z_][\w]*)/g;
const JS_INPUT_SCOPE_RE = /\binput\??\.scope\??\.([a-zA-Z_][\w]*)/g;
const JS_INPUT_SCOPE_BRACKET_RE = /\binput\??\.scope\[\s*["']([^"'\]]+)["']\s*\]/g;

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
  "iter",
  "i",
  "value",
  "v",
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

function referenceIsGuarded(text: string, ref: string): boolean {
  if (!/^[a-zA-Z_]\w*$/.test(ref)) return false;
  const access = String.raw`\binput\??\.scope(?:\??\.${ref}\b|\[\s*["']${ref}["']\s*\])`;
  const nullish = String.raw`[!=]==?\s*(?:null|undefined)`;
  return [
    new RegExp(String.raw`${access}\s*(?:\?|&&|\|\||${nullish})`),
    new RegExp(String.raw`(?:!\s*|typeof\s+)${access}`),
    new RegExp(String.raw`\binput\?\.scope\??\.${ref}\b|\binput\.scope\?\.${ref}\b`),
    new RegExp(String.raw`["']${ref}["']\s+in\s+input\??\.scope\b`),
  ].some((re) => re.test(text));
}

function collectReferences(
  text: string,
  knownIds: ReadonlySet<string>,
  emitOffender: (badRef: string) => void,
): void {
  for (const re of [
    SCOPE_PLACEHOLDER_RE,
    JSONATA_SCOPE_RE,
    JSONATA_STEPS_RE,
    JS_INPUT_SCOPE_RE,
    JS_INPUT_SCOPE_BRACKET_RE,
  ]) {
    const isJsAccess = re === JS_INPUT_SCOPE_RE || re === JS_INPUT_SCOPE_BRACKET_RE;
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const ref = m[1] ?? "";
      if (!ref || knownIds.has(ref)) continue;
      if (isJsAccess && referenceIsGuarded(text, ref)) continue;
      emitOffender(ref);
    }
  }
}

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
    const matchStart = bm.index;
    if (insideAnySpan(matchStart, stringSpans)) continue;
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
  JS_SCOPE_ACCESS_RE.lastIndex = 0;
  for (let jm = JS_SCOPE_ACCESS_RE.exec(text); jm !== null; jm = JS_SCOPE_ACCESS_RE.exec(text)) {
    const ref = jm[1] ?? "";
    if (!ref) continue;
    if (knownIds.has(ref)) continue;
    if (RESERVED_BARE_IDENTIFIERS.has(ref)) continue;
    emitOffender(ref);
  }
}

export function walkStrings(
  value: unknown,
  visit: (s: string, path: string) => void,
  path = "",
): void {
  if (typeof value === "string") {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walkStrings(v, visit, `${path}.${i}`);
    });
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkStrings(v, visit, `${path}.${k}`);
    }
  }
}

export function validateStepReferences(def: DomainWorkflowDef): ReferenceValidationError[] {
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
    walkStrings(step, (s) => {
      collectReferences(s, stepIds, (ref) => {
        emit(step.id, "*", ref, s.length > 120 ? `${s.slice(0, 120)}…` : s);
      });
    });
  }

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

export function partitionStepReferences(
  candidate: ReadonlyArray<ReferenceValidationError>,
  baseline: ReadonlyArray<ReferenceValidationError>,
): { introduced: ReferenceValidationError[]; inherited: ReferenceValidationError[] } {
  const byStep = new Set(
    baseline.map((e) => JSON.stringify([e.step_id, e.field, e.bad_reference])),
  );
  const byText = new Set(
    baseline.map((e) => JSON.stringify([e.field, e.bad_reference, e.context])),
  );
  const introduced: ReferenceValidationError[] = [];
  const inherited: ReferenceValidationError[] = [];
  for (const entry of candidate) {
    const known =
      byStep.has(JSON.stringify([entry.step_id, entry.field, entry.bad_reference])) ||
      byText.has(JSON.stringify([entry.field, entry.bad_reference, entry.context]));
    (known ? inherited : introduced).push(entry);
  }
  return { introduced, inherited };
}

export function describeStepReferences(errors: ReadonlyArray<ReferenceValidationError>): string {
  return errors
    .map(
      (e) =>
        `step \`${e.step_id}\`.${e.field} → unknown step \`${e.bad_reference}\`` +
        (e.did_you_mean.length > 0
          ? ` (did you mean: ${e.did_you_mean.map((s) => `\`${s}\``).join(", ")})`
          : ""),
    )
    .join("; ");
}

export function validateBareIterationIdentifiers(
  steps: ReadonlyArray<Record<string, unknown>>,
): ReferenceValidationError[] {
  const errors: ReferenceValidationError[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const s of steps) {
    if (typeof s.id === "string") byId.set(s.id, s);
  }
  const parentLoop = new Map<string, Record<string, unknown>>();
  for (const s of steps) {
    if (s.kind !== "loop" || !Array.isArray(s.body)) continue;
    for (const bodyId of s.body) {
      if (typeof bodyId === "string" && !parentLoop.has(bodyId)) parentLoop.set(bodyId, s);
    }
  }

  const jsonataSite = (step: Record<string, unknown>): { field: string; text: string } | null => {
    if (step.kind === "transform") {
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
    const found = findBareItemRefs(site.text, names);
    if (!found.ok) continue;
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

export function validateUnsupportedPlaceholders(
  def: DomainWorkflowDef,
): UnsupportedPlaceholderError[] {
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
      continue;
    }
    if (step.kind === "branch") {
      const br = step as { when?: string };
      if (br.when) visit(step.id, "when", br.when);
      continue;
    }
    if (step.kind === "transform") {
      const tx = step as { expression?: string; language?: string };
      const language = tx.language ?? "javascript";
      if (tx.expression && language !== "javascript") {
        visit(step.id, "expression", tx.expression);
      }
      continue;
    }
    const { for_each: _forEach, data_selector: _dataSelector, ...scannable } = step;
    visit(step.id, "*", scannable);
  }

  const outputTransform = (def as { output_transform?: unknown }).output_transform;
  if (typeof outputTransform === "string" && outputTransform.length > 0) {
    visit("(output_transform)", "output_transform", outputTransform);
  }

  return errors;
}
