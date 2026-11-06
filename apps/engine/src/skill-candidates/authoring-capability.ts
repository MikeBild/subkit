import { createHash } from "node:crypto";
import type { PatternSignal, WorkflowCapabilityFacts } from "./types.ts";

interface CapabilityWorkflowDef {
  name: string;
  input_schema?: unknown;
  output_schema?: unknown;
  steps: Array<Record<string, unknown>>;
}

type CapabilityScopeIndex = Record<
  string,
  { available_paths: string[]; shape_summary: string; primary_data_path: string | null }
>;

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

function inputFacts(input_schema: unknown): WorkflowCapabilityFacts["inputs"] {
  if (!input_schema || typeof input_schema !== "object") return [];
  const schema = input_schema as Record<string, unknown>;
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return Object.keys(props).map((name) => {
    const p = (props[name] ?? {}) as Record<string, unknown>;
    return {
      name,
      type: typeof p.type === "string" ? p.type : "any",
      required: required.includes(name),
    };
  });
}

function outputFields(output_schema: unknown): string[] | null {
  if (!output_schema || typeof output_schema !== "object") return null;
  const props = (output_schema as Record<string, unknown>).properties;
  return props && typeof props === "object" ? Object.keys(props) : [];
}

function workflowCapabilityFacts(args: {
  def: CapabilityWorkflowDef;
  scope_index: CapabilityScopeIndex;
  draft_version_id?: string;
}): WorkflowCapabilityFacts {
  const { def, scope_index } = args;
  const steps = def.steps.flatMap((s) =>
    typeof s.id === "string" ? [{ id: s.id, kind: typeof s.kind === "string" ? s.kind : "?" }] : [],
  );
  const last = steps[steps.length - 1];
  return {
    kind: "workflow_capability",
    inputs: inputFacts(def.input_schema),
    output_fields: outputFields(def.output_schema),
    key_paths: (last ? scope_index[last.id]?.available_paths : undefined)?.slice(0, 12) ?? [],
    connector_ids: Array.from(
      new Set(
        def.steps.flatMap((s) => (typeof s.connector_id === "string" ? [s.connector_id] : [])),
      ),
    ),
    steps,
    draft_version_id: args.draft_version_id ?? null,
  };
}

function describeInputs(inputs: WorkflowCapabilityFacts["inputs"]): string {
  if (inputs.length === 0) return "none declared";
  return inputs
    .map((input) => `${input.name}: ${input.type}${input.required ? " (required)" : ""}`)
    .join("; ");
}

export function authoringCapabilitySignal(args: {
  workflow_id: string;
  slug: string;
  name: string;
  def: CapabilityWorkflowDef;
  scope_index: CapabilityScopeIndex;
  draft_version_id?: string;
}): PatternSignal {
  const { workflow_id, slug, name } = args;
  const facts = workflowCapabilityFacts(args);
  const exampleInvocation = facts.draft_version_id
    ? `GET /v1/workflows/${workflow_id}/draft — inspect only; activation and execution authority are required before a live run`
    : `POST /v1/workflows/${slug}/runs  body: { "input": { … } }`;

  const body = [
    `Workflow '${name}' (slug ${slug}) — what it does and how to invoke it.`,
    ...(facts.draft_version_id
      ? [
          `Saved draft version ${facts.draft_version_id}. This note describes preparation, not an active capability; the workflow is neither activated nor authorized to run.`,
        ]
      : []),
    `Inputs: ${describeInputs(facts.inputs)}.`,
    `Output fields: ${facts.output_fields ? facts.output_fields.join(", ") || "none declared" : "not declared"}.`,
    facts.connector_ids.length > 0
      ? `Connectors: ${facts.connector_ids.join(", ")}.`
      : "Connectors: none (transform/inline only).",
    `Steps: ${facts.steps.map((step) => step.kind).join(" → ")}.`,
    ...(facts.key_paths.length > 0 ? [`Key output paths: ${facts.key_paths.join(", ")}.`] : []),
    `Example invocation: ${exampleInvocation}`,
  ].join("\n");

  const fingerprint = createHash("sha256")
    .update(
      `authoring_capability:${workflow_id}:${canonicalJson(args.def.input_schema ?? null)}:${canonicalJson(
        args.def.output_schema ?? null,
      )}`,
    )
    .digest("hex")
    .slice(0, 32);

  return {
    pattern_kind: "authoring_capability",
    scope: "workflow",
    workflow_id,
    ...(facts.connector_ids.length === 1 ? { connector_id: facts.connector_ids[0] } : {}),
    title: `Workflow '${slug}' capabilities`,
    body,
    examples: [exampleInvocation],
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    facts,
    fingerprint,
    confidence: "high",
    evidence: [
      {
        evidence_type: facts.draft_version_id ? "workflow_draft_saved" : "workflow_committed",
        summary: `${facts.draft_version_id ? "Saved draft of" : "Committed"} workflow '${slug}' (${facts.steps.length} step(s)${
          facts.connector_ids.length > 0 ? `, connectors: ${facts.connector_ids.join(", ")}` : ""
        }).`,
      },
    ],
  };
}
