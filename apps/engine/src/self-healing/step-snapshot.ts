// Failing-step snapshot loaders shared by the repair loop
// (service.ts) and the operator-facing candidate review surface
// (candidate-review.ts).

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { executionSteps } from "../db/schema/index.ts";
import { RequestMetaSchema } from "../execution/request-meta-schema.ts";
import type { FailingStepSnapshot } from "./drift-detector.ts";
import type { DryRunStep } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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
    kind: row.kind,
    status: row.status,
    error: row.error,
    request_meta: parsePersistedRequestMeta(row.request_meta),
    output_preview: row.output_preview,
  };
}
