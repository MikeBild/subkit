// Synthesize a workflow MCP `inputSchema` from its DAG when the author
// didn't declare one explicitly.
//
// Two signal sources:
//   1. `${input.<pointer>}` placeholders in request URLs / paths /
//      headers / query values / body strings (parsed via the canonical
//      `parsePlaceholders`).
//   2. `input.input.<identifier>` references inside JavaScript transform
//      bodies (the sole transform language), plus `$input.<identifier>`
//      inside the remaining JSONata slots (`branch.when`).
//
// Output: `{type: "object", properties: {foo: {type: "string"}}, additionalProperties: true}`.
// Each property's scalar `type` is inferred from how the placeholder is
// used: a placeholder that is the WHOLE value of a JSON leaf is a typed
// substitution (the runtime returns the native value), so a numeric or
// boolean coercion in a JavaScript transform (`Number(...)`, `parseInt(...)`,
// `Boolean(...)`) narrows it to `number` / `integer` / `boolean`. A
// placeholder embedded in a larger string is always string-interpolated, so
// it pins the property to `string`. When the two conflict, `string` wins —
// it is the safe default for runtime substitution. Operators who want
// stricter typing (or descriptions) declare `input_schema` on the DAG;
// synth never fabricates descriptions. Returns `null` when nothing
// references `input`.

import { extractAst } from "../execution/jsonata-engine.ts";
import { parsePlaceholders } from "../llm/substitution/parser.ts";
import { sampleToSchema } from "./sample-to-schema.ts";
import type { StepDef, WorkflowDef } from "./types.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

type ScalarType = "string" | "number" | "integer" | "boolean";

type JsonSchemaProperty = { type: ScalarType; description?: string };

type JsonSchemaObject = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  additionalProperties: true;
};

// Per-input-name accumulator of the type signals seen across the DAG. A
// `string` observation is dominant (string interpolation must yield a
// string); the scalar coercion observations only decide the type when no
// string interpolation pins the name.
interface TypeObservations {
  string: boolean;
  number: boolean;
  integer: boolean;
  boolean: boolean;
}

type ObservationMap = Map<string, TypeObservations>;

function note(into: ObservationMap, name: string, kind?: keyof TypeObservations): void {
  let obs = into.get(name);
  if (!obs) {
    obs = { string: false, number: false, integer: false, boolean: false };
    into.set(name, obs);
  }
  if (kind) obs[kind] = true;
}

function resolveScalarType(obs: TypeObservations): ScalarType {
  // String interpolation is dominant: an embedded `${input.x}` is always
  // rendered as text, so the property cannot be anything narrower.
  if (obs.string) return "string";
  const hasNumeric = obs.number || obs.integer;
  // Conflicting scalar coercions (a name used as both a number and a
  // boolean) are not determinable — fall back to the safe default.
  if (obs.boolean && hasNumeric) return "string";
  if (obs.boolean) return "boolean";
  if (obs.number) return "number";
  if (obs.integer) return "integer";
  return "string";
}

// True when the trimmed string is exactly one `${...}` token spanning the
// whole value — the runtime substitutes the native typed value here (no
// `String()`), so the JSON leaf carries the input's own type. Mirrors the
// "single full placeholder" detection in substitution/resolver.ts.
function isWholeStringPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("${") || !trimmed.endsWith("}") || trimmed.startsWith("$${")) {
    return false;
  }
  const { tokens, errors } = parsePlaceholders(trimmed);
  return (
    errors.length === 0 &&
    tokens.length === 1 &&
    tokens[0]!.span.start === 0 &&
    tokens[0]!.span.end === trimmed.length
  );
}

function collectFromString(text: string, into: ObservationMap): void {
  // A placeholder embedded in surrounding characters is string-interpolated;
  // a whole-string placeholder is a typed leaf whose scalar type may be
  // narrowed by a coercion elsewhere, so it registers without pinning string.
  const embedded = !isWholeStringPlaceholder(text);
  const { tokens } = parsePlaceholders(text);
  for (const tok of tokens) {
    if (tok.kind !== "input") continue;
    const first = tok.path[0];
    if (first && typeof first === "string" && first.length > 0) {
      note(into, first, embedded ? "string" : undefined);
    }
  }
}

function collectFromJson(value: JsonValue | undefined, into: ObservationMap): void {
  if (value == null) return;
  if (typeof value === "string") {
    collectFromString(value, into);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectFromJson(v, into);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) collectFromJson(v as JsonValue, into);
  }
}

// Jsonata AST traversal. Recurses over every own property (including
// arrays and nested arrays) so object constructors and other nested
// shapes aren't missed.
interface AstNode {
  type?: string;
  value?: unknown;
  steps?: unknown;
}

function collectFromJsonataAst(node: unknown, into: ObservationMap): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectFromJsonataAst(child, into);
    return;
  }
  const ast = node as AstNode;
  if (ast.type === "path" && Array.isArray(ast.steps) && ast.steps.length >= 2) {
    const [head, next] = ast.steps as AstNode[];
    const isInputVar = head?.type === "variable" && head?.value === "input";
    const isInputName = head?.type === "name" && head?.value === "input";
    if (isInputVar || isInputName) {
      if (next?.type === "name" && typeof next.value === "string" && next.value.length > 0) {
        // The reference type inside a `when` predicate isn't determinable
        // from the AST — register the name and let it default to string.
        note(into, next.value);
      }
    }
  }
  for (const [k, v] of Object.entries(ast)) {
    if (k === "type" || k === "value" || k === "position") continue;
    collectFromJsonataAst(v, into);
  }
}

// JS counterpart of the JSONata `$input.<name>` walk: workflow-input
// references inside a JavaScript transform body. Dot access and quoted
// bracket access are both recognised (bracket covers names dot-syntax can't
// express). Mirrors `extractJsScopeReferences` in conversations/js-transform-eval.ts.
const JS_INPUT_REF_PATTERNS = [
  /\binput\??\.input\??\.([A-Za-z_$][A-Za-z0-9_$]*)/g,
  /\binput\??\.input\[\s*["']([^"'\]]+)["']\s*\]/g,
];

// Scalar coercions wrapping a dot-access workflow-input reference. When an
// input is only ever coerced this way (never string-interpolated), its
// synthesized property type narrows accordingly. Bracket-access coercion is
// left to default to string — a deliberately conservative omission.
const JS_COERCE_PATTERNS: ReadonlyArray<[keyof TypeObservations, RegExp[]]> = [
  [
    "number",
    [
      /\bNumber\s*\(\s*input\??\.input\??\.([A-Za-z_$][A-Za-z0-9_$]*)/g,
      /\bparseFloat\s*\(\s*input\??\.input\??\.([A-Za-z_$][A-Za-z0-9_$]*)/g,
    ],
  ],
  ["integer", [/\bparseInt\s*\(\s*input\??\.input\??\.([A-Za-z_$][A-Za-z0-9_$]*)/g]],
  ["boolean", [/\bBoolean\s*\(\s*input\??\.input\??\.([A-Za-z_$][A-Za-z0-9_$]*)/g]],
];

function collectJsInputRefs(code: string, into: ObservationMap): void {
  for (const re of JS_INPUT_REF_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const name = m[1];
      if (name && name.length > 0) note(into, name);
    }
  }
  for (const [kind, patterns] of JS_COERCE_PATTERNS) {
    for (const re of patterns) {
      re.lastIndex = 0;
      for (let m = re.exec(code); m !== null; m = re.exec(code)) {
        const name = m[1];
        if (name && name.length > 0) note(into, name, kind);
      }
    }
  }
}

function collectFromStep(step: StepDef, into: ObservationMap): void {
  // 1. Driver-agnostic scan of EVERY string leaf on the step for
  //    `${input.*}` placeholders. This captures the request
  //    url/path/headers/query/body the old per-field enumeration handled,
  //    but ALSO the surfaces it silently missed: multipart part
  //    values/filenames, the s3 `key`/`prefix`/`metadata`, graphql
  //    `query` + `variables`, sql `query` + `params`, the xml body, and a
  //    `call` step's sub-workflow `input`. A missed surface previously
  //    synthesized a PARTIAL contract (an s3 upload with body
  //    `${input.markdown}` but key `${input.filename}` yielded only
  //    `markdown`) or NO contract at all (multipart / call / graphql),
  //    which collapsed the run_workflow input form into a single
  //    free-text prompt and let the run reach the driver with a required
  //    `${input.*}` field unbound (input_schema_violation at runtime).
  //    The embedded-vs-whole-string typing is preserved because each
  //    string still flows through `collectFromString`.
  collectFromJson(step as unknown as JsonValue, into);

  // 2. JavaScript transform bodies reference workflow input as
  //    `input.input.<name>` / `input.input["name"]` — no `${...}` wrapper,
  //    so the placeholder scan above cannot see them. Extract explicitly.
  if (
    step.kind === "transform" &&
    typeof step.expression === "string" &&
    step.expression.length > 0
  ) {
    collectJsInputRefs(step.expression, into);
  }

  // 3. JSONata `branch.when` predicates reference input as `$input.<name>`.
  if (step.kind === "branch" && step.when) {
    const ast = extractAst(step.when) as AstNode | null;
    if (ast) collectFromJsonataAst(ast, into);
  }
}

export function synthesizeInputSchema(dag: WorkflowDef): JsonSchemaObject | null {
  const observations: ObservationMap = new Map();
  for (const step of dag.steps) collectFromStep(step, observations);
  if (observations.size === 0) return null;

  const properties: Record<string, JsonSchemaProperty> = {};
  for (const n of [...observations.keys()].sort()) {
    properties[n] = { type: resolveScalarType(observations.get(n)!) };
  }
  return { type: "object", properties, additionalProperties: true };
}

export interface WorkflowInputContract {
  /** Effective schema: declared `input_schema`, else the sample-derived
   *  one, else the structural synth. */
  schema: Record<string, unknown>;
  /** Which precedence tier produced `schema`:
   *   - `declared` — the author's hand-tuned `input_schema`.
   *   - `sample`   — derived from `input_schema_sample` (the payload-first idiom).
   *   - `synth`    — scraped from `${input.*}` / `input.input.*` placeholders.
   *  Surfaced by `inspect_workflow` so the model can tell whether the run
   *  contract is a real declared/sampled shape or a best-effort structural guess. */
  source: "declared" | "sample" | "synth";
  /** Declared property names. */
  properties: string[];
  /** Keys a run must supply. From `schema.required` when the tier that
   *  won carries a non-empty `required` (declared schemas and
   *  sample-derived schemas do); otherwise EVERY property — the
   *  structural synth never emits `required`, and a placeholder
   *  substituting null/undefined at runtime is worse than one extra
   *  confirmation. */
  required: string[];
}

/**
 * Sample-derived tier of the input contract. The draft carries an
 * `input_schema_sample` — a literal example payload the author (or a
 * dry-run) supplied. `sampleToSchema` turns that concrete value into a
 * tight JSON Schema whose `required` names every observed key, giving
 * `run_workflow` a real form instead of a single free-text prompt.
 *
 * Only a sample that describes an OBJECT WITH NAMED KEYS yields a usable
 * contract: a scalar / array / empty-object sample carries no property
 * names to require, so it returns `null` and the caller falls through to
 * the structural synth. `input_schema_sample` is a typed (optional)
 * `WorkflowDef` field persisted in the versioned definition, so it is read
 * directly — a SAVED workflow that carried a sample resolves this tier, not
 * just an in-flight draft.
 */
function sampleDerivedSchema(dag: WorkflowDef): Record<string, unknown> | null {
  const sample = dag.input_schema_sample;
  if (sample === undefined || sample === null) return null;
  const schema = sampleToSchema(sample);
  if (schema.type !== "object") return null;
  const props = schema.properties;
  if (!props || typeof props !== "object" || Object.keys(props as object).length === 0) {
    return null;
  }
  return schema;
}

/**
 * The workflow's effective input contract — the SAME source everywhere:
 * the `wf_<slug>` tool schema, the persist-envelope usage block, the
 * `run_workflow` missing-input gate, and the chat fast-path all read
 * this, so no surface can disagree about what a run needs.
 * Returns `null` when the workflow takes no input.
 *
 * Precedence, most authoritative first:
 *   1. declared `input_schema` — the author's explicit, hand-tuned contract.
 *   2. sample-derived — `sampleToSchema(input_schema_sample)` when the draft
 *      carries an object example payload (required = every sample key).
 *   3. structural synth — `${input.*}` / `input.input.*` placeholders scraped
 *      from the DAG (no `required` of its own; every property is required).
 */
export function resolveWorkflowInputContract(dag: WorkflowDef): WorkflowInputContract | null {
  const declared =
    dag.input_schema && typeof dag.input_schema === "object"
      ? (dag.input_schema as Record<string, unknown>)
      : null;
  const declaredWins = declared !== null && Object.keys(declared).length > 0;
  // Compute the winning tier explicitly (not just the schema) so callers can
  // report WHICH source the run contract came from. Order mirrors the doc
  // above: declared > sample > synth.
  const sampleSchema = declaredWins ? null : sampleDerivedSchema(dag);
  let source: WorkflowInputContract["source"];
  let schema: Record<string, unknown> | null;
  if (declaredWins) {
    source = "declared";
    schema = declared;
  } else if (sampleSchema) {
    source = "sample";
    schema = sampleSchema;
  } else {
    source = "synth";
    schema = (synthesizeInputSchema(dag) as Record<string, unknown> | null) ?? null;
  }
  if (!schema) return null;
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? Object.keys(schema.properties as Record<string, unknown>)
      : [];
  if (properties.length === 0) return null;
  const required =
    Array.isArray(schema.required) && schema.required.length > 0
      ? schema.required.filter((k): k is string => typeof k === "string")
      : properties;
  return { schema, source, properties, required };
}
