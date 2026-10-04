import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../db/client.ts";
import { executionSteps } from "../db/schema/index.ts";
import { RequestMetaSchema } from "../execution/request-meta-schema.ts";
import { graphqlEndpointKey } from "../schema-versions/service.ts";
import type { FailingStepSnapshot } from "./drift-detector.ts";
import type { DryRunStep } from "./types.ts";

export function buildDryRunStep(snapshot: FailingStepSnapshot): DryRunStep {
  const kind = snapshot.kind === "transform" ? "transform" : "request";
  const step: DryRunStep = { id: snapshot.id, kind };
  if (typeof snapshot.expression === "string") step.expression = snapshot.expression;
  return step;
}

export function parsePersistedRequestMeta(
  raw: unknown,
): import("../execution/types.ts").RequestMeta | null {
  if (raw === null || raw === undefined) return null;
  const parsed = RequestMetaSchema.safeParse(raw);
  return parsed.success ? (parsed.data as import("../execution/types.ts").RequestMeta) : null;
}

export function endpointKeyFromRequestMeta(
  meta: import("../execution/types.ts").RequestMeta | null,
): string | null {
  if (!meta) return null;
  switch (meta.driver) {
    case "http": {
      if (!meta.url) return null;
      try {
        return `${meta.method ?? "GET"} ${new URL(meta.url).pathname}`;
      } catch {
        return null;
      }
    }
    case "graphql":
      return meta.operation_name ? graphqlEndpointKey(meta.operation_name) : null;
    case "s3":
      return `S3 ${meta.method} ${meta.prefix ?? meta.key ?? "/"}`;
    case "postgres":
      return `SQL ${meta.query_preview.slice(0, 80)}`;
    default:
      return null;
  }
}

export async function loadWorkflowStepKey(
  tenant_id: string,
  execution_step_id: string,
  exec: Executor,
): Promise<string | null> {
  if (!isExecutionStepId(execution_step_id)) return null;
  const rows = await exec
    .select({ step_key: executionSteps.step_key })
    .from(executionSteps)
    .where(and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.id, execution_step_id)))
    .limit(1);
  return rows[0]?.step_key ?? null;
}

export async function resolveCandidateStepKey(
  tenant_id: string,
  diff: Record<string, unknown>,
  exec: Executor,
): Promise<string | null> {
  if (typeof diff.workflow_step_id === "string") return diff.workflow_step_id;
  if (typeof diff.step_id !== "string") return null;
  return loadWorkflowStepKey(tenant_id, diff.step_id, exec);
}

export async function loadStepSnapshot(
  tenant_id: string,
  step_id: string,
  exec: Executor,
): Promise<FailingStepSnapshot | null> {
  const rows = await exec
    .select()
    .from(executionSteps)
    .where(and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.id, step_id)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    step_key: row.step_key,
    kind: row.kind,
    status: row.status,
    error: row.error,
    request_meta: parsePersistedRequestMeta(row.request_meta),
    output_preview: row.output_preview,
  };
}

const ExecutionStepId = z.string().uuid();
export function isExecutionStepId(value: unknown): value is string {
  return ExecutionStepId.safeParse(value).success;
}
