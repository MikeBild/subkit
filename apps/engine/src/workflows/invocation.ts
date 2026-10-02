// What a caller needs to know to run a saved workflow: which input it takes,
// a sample of it, and whether a run would have effects.
//
// The pieces here are the workflow's own facts. Where the call is posted, the
// hooks, the schedules and the tool name belong to other subsystems; the
// invocation route assembles them (`http/routes/workflow-invocation.ts`).

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflowExecutionAuthorities } from "../db/schema/index.ts";
import { synthesizeInputSchema } from "./input-schema-synth.ts";
import type { WorkflowDef } from "./types.ts";

export type WorkflowInputSchemaSource = "declared" | "synthesized" | "none";

export interface WorkflowInputSchema {
  source: WorkflowInputSchemaSource;
  schema: Record<string, unknown> | null;
}

/**
 * The input schema a caller is shown: the declared one when the workflow has
 * one, else the one inferred from the input references in its steps, else none.
 * The one rule behind `GET …/input-schema` and `GET …/invocation`.
 */
export function resolveWorkflowInputSchema(definition: WorkflowDef): WorkflowInputSchema {
  if (definition.input_schema) return { source: "declared", schema: definition.input_schema };
  const synthesized = synthesizeInputSchema(definition);
  if (synthesized) return { source: "synthesized", schema: synthesized as Record<string, unknown> };
  return { source: "none", schema: null };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A placeholder of the declared type; a string names its own field. */
function placeholder(name: string, property: Record<string, unknown>, depth: number): unknown {
  if (Array.isArray(property.examples) && property.examples.length > 0) return property.examples[0];
  if (property.example !== undefined) return property.example;
  if (property.default !== undefined) return property.default;
  if (property.const !== undefined) return property.const;
  if (Array.isArray(property.enum) && property.enum.length > 0) return property.enum[0];
  const type = Array.isArray(property.type) ? property.type[0] : property.type;
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") return depth < 1 ? sampleFromSchema(property, depth + 1) : {};
  if (type === "null") return null;
  return `<${name}>`;
}

/**
 * A sample input that satisfies the shape of `schema`: every required
 * property, or every property when the schema names none as required (an
 * inferred schema never does). Values are an example, default or enum member
 * the schema itself offers, else a placeholder of the declared type.
 */
export function sampleFromSchema(
  schema: Record<string, unknown> | null,
  depth = 0,
): Record<string, unknown> {
  if (!schema || !record(schema.properties)) return {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
  // `fromEntries` defines every key as a property; assigning `sample[name]`
  // would set the prototype for a property named `__proto__` and lose it.
  return Object.fromEntries(
    Object.entries(schema.properties)
      .filter(([name]) => required.length === 0 || required.includes(name))
      .map(([name, raw]) => [name, placeholder(name, record(raw) ? raw : {}, depth)]),
  );
}

/**
 * The sample input shown beside the call: the author's own example payload
 * (`input_schema_sample`) when the workflow carries one, else one derived from
 * the schema. Always an object — a run's input travels as one.
 */
export function workflowSampleInput(
  definition: WorkflowDef,
  schema: Record<string, unknown> | null,
): Record<string, unknown> {
  const authored = definition.input_schema_sample;
  if (record(authored) && Object.keys(authored).length > 0) return authored;
  return sampleFromSchema(schema);
}

export type RunAuthorityMode = "live_run_allowed" | "held_preview_only";

/**
 * Per environment: whether an approval for the version runs use EXISTS —
 * unrevoked, inside its window and not used up.
 *
 * That is all `live_run_allowed` says. Admission asks two more things this
 * does not: that the approval's effect manifest still matches the workflow's
 * current effects, and that those effects are eligible for repeated runs. An
 * approval a later connector or credential change has invalidated therefore
 * still reads `live_run_allowed` here while admission holds or refuses the
 * run. Recomputing the manifest resolves every connector and credential the
 * workflow touches, per environment; the full check is
 * `GET …/automation-status`, and this is the cheap answer a page can afford
 * on every open. The schema and the docs describe it as exactly that.
 */
export async function workflowRunAuthority(
  db: Executor,
  workflow: {
    tenant_id: string;
    id: string;
    lifecycle: string;
    current_version_id: string | null;
  },
): Promise<Record<"dev" | "prod", RunAuthorityMode>> {
  const answer: Record<"dev" | "prod", RunAuthorityMode> = {
    dev: "held_preview_only",
    prod: "held_preview_only",
  };
  if (workflow.lifecycle !== "active" || !workflow.current_version_id) return answer;
  const rows = await db
    .selectDistinct({ environment: workflowExecutionAuthorities.execution_environment })
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, workflow.tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, workflow.id),
        eq(workflowExecutionAuthorities.workflow_version_id, workflow.current_version_id),
        isNull(workflowExecutionAuthorities.revoked_at),
        sql`${workflowExecutionAuthorities.valid_from} <= clock_timestamp()`,
        sql`${workflowExecutionAuthorities.valid_until} > clock_timestamp()`,
        sql`${workflowExecutionAuthorities.reserved_runs} < ${workflowExecutionAuthorities.max_runs}`,
      ),
    );
  for (const row of rows) answer[row.environment] = "live_run_allowed";
  return answer;
}

/**
 * What a delivery looks like when it reaches the workflow as `input`. The
 * caller's request body is one field of it, not the input itself.
 */
export const WEBHOOK_INPUT_SHAPE = {
  id: "string",
  type: "string",
  timestamp: "number",
  headers: "object",
  body: "json",
} as const;
