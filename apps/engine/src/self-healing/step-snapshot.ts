// Failing-step snapshot loaders shared by the repair loop
// (service.ts) and the operator-facing candidate review surface
// (candidate-review.ts).

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Executor } from "../db/client.ts";
import { executionSteps } from "../db/schema/index.ts";
import { RequestMetaSchema } from "../execution/request-meta-schema.ts";
import { graphqlEndpointKey } from "../schema-versions/service.ts";
import type { FailingStepSnapshot } from "./drift-detector.ts";
import type { DryRunStep } from "./types.ts";

export function buildDryRunStep(snapshot: FailingStepSnapshot): DryRunStep {
  // `data_selector` / `response_filters` / `expression` come from the
  // persisted step config (whoever upstream loaded the snapshot
  // populated `snapshot.expression`); the typed RequestMeta union
  // intentionally doesn't carry them. Future expansion: surface
  // additional dry-run inputs on FailingStepSnapshot itself.
  const kind = snapshot.kind === "transform" ? "transform" : "request";
  const step: DryRunStep = { id: snapshot.id, kind };
  if (typeof snapshot.expression === "string") step.expression = snapshot.expression;
  return step;
}

/**
 * Parse the persisted JSONB request_meta payload through the strict
 * RequestMeta schema. Tolerant fall-through: rows persisted before
 * the typed-union migration, or with a future driver variant we
 * don't recognise here, return `null` rather than crashing the
 * repair loop.
 */
export function parsePersistedRequestMeta(
  raw: unknown,
): import("../execution/types.ts").RequestMeta | null {
  if (raw === null || raw === undefined) return null;
  const parsed = RequestMetaSchema.safeParse(raw);
  return parsed.success ? (parsed.data as import("../execution/types.ts").RequestMeta) : null;
}

/**
 * Derive the shape/dedup endpoint key from a persisted request_meta —
 * the SAME key the driver's recordSuccessShape call writes, so the
 * repair loop's `getLatestShape` lookup and the patch-candidate
 * endpoint dedup land on the identical identity:
 *
 *   http      → `${method} ${pathname}`            (dispatch.ts http sites)
 *   graphql   → graphqlEndpointKey(operation_name) (operation-aware)
 *   s3        → `S3 ${method} ${prefix ?? key ?? "/"}`
 *   postgres  → `SQL ${query_preview.slice(0, 80)}`
 *
 * Null when the meta variant carries no stable anchor (connectorless,
 * error, missing operation_name).
 */
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

/**
 * Resolve the DAG step id behind a failing *execution* step.
 *
 * `execution_steps.step_key` is written by the engine as the DAG step's own
 * `id`, so it is the link between "this run broke" and "this line of the
 * workflow definition". Both the operator preview and the apply path resolve
 * their target through here, which is what keeps the previewed diff and the
 * applied version pointed at the same step.
 *
 * Null when the id does not resolve — the caller must treat that as "no step
 * to patch", never as "patch a guess".
 */
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

/**
 * Resolve the definition step a candidate's diff points at.
 *
 * Two anchors, in order of directness:
 *   1. `workflow_step_id` — the definition step recorded at proposal time. A
 *      proactive signal has this and nothing else.
 *   2. `step_id` — the failing *execution* row, one hop from the definition.
 *
 * Preview and apply resolve through this one function so the operator can
 * never review a different step than the one the apply path rewrites.
 */
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
