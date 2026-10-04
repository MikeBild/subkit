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
  if (obs.string) return "string";
  const hasNumeric = obs.number || obs.integer;
  if (obs.boolean && hasNumeric) return "string";
  if (obs.boolean) return "boolean";
  if (obs.number) return "number";
  if (obs.integer) return "integer";
  return "string";
}

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
        note(into, next.value);
      }
    }
  }
  for (const [k, v] of Object.entries(ast)) {
    if (k === "type" || k === "value" || k === "position") continue;
    collectFromJsonataAst(v, into);
  }
}

const JS_INPUT_REF_PATTERNS = [
  /\binput\??\.input\??\.([A-Za-z_$][A-Za-z0-9_$]*)/g,
  /\binput\??\.input\[\s*["']([^"'\]]+)["']\s*\]/g,
];

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
  collectFromJson(step as unknown as JsonValue, into);

  if (
    step.kind === "transform" &&
    typeof step.expression === "string" &&
    step.expression.length > 0
  ) {
    collectJsInputRefs(step.expression, into);
  }

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
  schema: Record<string, unknown>;
  source: "declared" | "sample" | "synth";
  properties: string[];
  required: string[];
}

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

export function resolveWorkflowInputContract(dag: WorkflowDef): WorkflowInputContract | null {
  const declared =
    dag.input_schema && typeof dag.input_schema === "object"
      ? (dag.input_schema as Record<string, unknown>)
      : null;
  const declaredWins = declared !== null && Object.keys(declared).length > 0;
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
  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === "string")
    : source === "declared"
      ? []
      : properties;
  return { schema, source, properties, required };
}
