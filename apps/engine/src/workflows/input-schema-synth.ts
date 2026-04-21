// Synthesize a workflow MCP `inputSchema` from its DAG when the author
// didn't declare one explicitly.
//
// Two signal sources:
//   1. `${input.<pointer>}` placeholders in request URLs / paths /
//      headers / query values / body strings (parsed via the canonical
//      `parsePlaceholders`).
//   2. `$input.<identifier>` (and bare `input.<identifier>`) references
//      inside jsonata transform expressions, walked via jsonata's AST.
//
// Output: `{type: "object", properties: {foo: {type: "string"}}, additionalProperties: true}`
// or `null` when nothing references `input`. String is the safe default
// — operators who want stricter typing declare `input_schema` on the DAG.

import jsonata from "jsonata";
import { parsePlaceholders } from "../llm/substitution/parser.ts";
import type { StepDef, WorkflowDef } from "./types.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

type JsonSchemaObject = {
  type: "object";
  properties: Record<string, { type: "string" }>;
  additionalProperties: true;
};

function collectFromString(text: string, into: Set<string>): void {
  const { tokens } = parsePlaceholders(text);
  for (const tok of tokens) {
    if (tok.kind !== "input") continue;
    const first = tok.path[0];
    if (first && typeof first === "string" && first.length > 0) into.add(first);
  }
}

function collectFromJson(value: JsonValue | undefined, into: Set<string>): void {
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

function collectFromJsonataAst(node: unknown, into: Set<string>): void {
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
        into.add(next.value);
      }
    }
  }
  for (const [k, v] of Object.entries(ast)) {
    if (k === "type" || k === "value" || k === "position") continue;
    collectFromJsonataAst(v, into);
  }
}

function collectFromStep(step: StepDef, into: Set<string>): void {
  if (step.kind === "request") {
    if (step.url) collectFromString(step.url, into);
    if (step.path) collectFromString(step.path, into);
    if (step.headers) {
      for (const v of Object.values(step.headers)) collectFromString(v, into);
    }
    if (step.query) {
      for (const v of Object.values(step.query)) {
        if (typeof v === "string") collectFromString(v, into);
      }
    }
    if (step.body !== undefined) collectFromJson(step.body, into);
    return;
  }
  if (step.kind === "transform") {
    const language = step.language ?? "jsonata";
    if (language !== "jsonata") return;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: jsonata's .ast() is untyped.
      const ast = (jsonata(step.expression) as any).ast() as AstNode;
      if (ast) collectFromJsonataAst(ast, into);
    } catch {
      // Malformed expressions simply contribute nothing to the schema.
    }
    return;
  }
  if (step.kind === "branch" && step.when) {
    // `when` is typed as a jsonata expression string.
    try {
      // biome-ignore lint/suspicious/noExplicitAny: jsonata's .ast() is untyped.
      const ast = (jsonata(step.when) as any).ast() as AstNode;
      if (ast) collectFromJsonataAst(ast, into);
    } catch {
      // ignore
    }
  }
}

export function synthesizeInputSchema(dag: WorkflowDef): JsonSchemaObject | null {
  const names = new Set<string>();
  for (const step of dag.steps) collectFromStep(step, names);
  if (names.size === 0) return null;

  const properties: Record<string, { type: "string" }> = {};
  for (const n of [...names].sort()) properties[n] = { type: "string" };
  return { type: "object", properties, additionalProperties: true };
}
