import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflowExecutionAuthorities } from "../db/schema/index.ts";
import { authorityLive } from "./authority-live.ts";
import { synthesizeInputSchema } from "./input-schema-synth.ts";
import type { WorkflowDef } from "./types.ts";

export type WorkflowInputSchemaSource = "declared" | "synthesized" | "none";

export interface WorkflowInputSchema {
  source: WorkflowInputSchemaSource;
  schema: Record<string, unknown> | null;
}

export function resolveWorkflowInputSchema(definition: WorkflowDef): WorkflowInputSchema {
  if (definition.input_schema) return { source: "declared", schema: definition.input_schema };
  const synthesized = synthesizeInputSchema(definition);
  if (synthesized) return { source: "synthesized", schema: synthesized as Record<string, unknown> };
  return { source: "none", schema: null };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

export function sampleFromSchema(
  schema: Record<string, unknown> | null,
  depth = 0,
): Record<string, unknown> {
  if (!schema || !record(schema.properties)) return {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
  return Object.fromEntries(
    Object.entries(schema.properties)
      .filter(([name]) => required.length === 0 || required.includes(name))
      .map(([name, raw]) => [name, placeholder(name, record(raw) ? raw : {}, depth)]),
  );
}

export function workflowSampleInput(
  definition: WorkflowDef,
  schema: Record<string, unknown> | null,
): Record<string, unknown> {
  const authored = definition.input_schema_sample;
  if (record(authored) && Object.keys(authored).length > 0) return authored;
  return sampleFromSchema(schema);
}

export type RunAuthorityMode = "live_run_allowed" | "held_preview_only";

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
        authorityLive(),
      ),
    );
  for (const row of rows) answer[row.environment] = "live_run_allowed";
  return answer;
}

export const WEBHOOK_INPUT_SHAPE = {
  id: "string",
  type: "string",
  timestamp: "number",
  headers: "object",
  body: "json",
} as const;
