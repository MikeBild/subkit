import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { connectors, type Executor, executionSteps, type executions } from "../../db/index.ts";
import {
  connectorIdOf,
  deriveRecordLinks,
  isSealedPayload,
  type RecordLink,
} from "../record-links.ts";
import { getBuiltinTemplate } from "../templates.ts";

type RecordLinkExecution = Pick<
  typeof executions.$inferSelect,
  "id" | "tenant_id" | "input" | "hold_writes" | "sensitive_result"
>;

export async function loadRecordLinks(
  db: Executor,
  execution: RecordLinkExecution,
): Promise<RecordLink[]> {
  if (
    execution.hold_writes ||
    isSealedPayload(execution.input) ||
    isSealedPayload(execution.sensitive_result)
  )
    return [];
  const steps = await db
    .select({
      step_key: executionSteps.step_key,
      kind: executionSteps.kind,
      status: executionSteps.status,
      held: executionSteps.held,
      output_preview: executionSteps.output_preview,
      request_meta: executionSteps.request_meta,
      redacted_fields: executionSteps.redacted_fields,
      result_storage_uri: executionSteps.result_storage_uri,
    })
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, execution.tenant_id),
        eq(executionSteps.execution_id, execution.id),
        eq(executionSteps.kind, "request"),
        eq(executionSteps.status, "succeeded"),
        eq(executionSteps.held, false),
      ),
    )
    .orderBy(
      asc(executionSteps.step_index),
      asc(executionSteps.started_at),
      asc(executionSteps.id),
    );
  const ids = [
    ...new Set(steps.map(connectorIdOf).filter((id): id is string => id !== null)),
  ].sort();
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: connectors.id, template_slug: connectors.template_slug })
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, execution.tenant_id),
        inArray(connectors.id, ids),
        isNull(connectors.deleted_at),
      ),
    );
  const templates = new Map(
    rows.map((row) => [row.id, row.template_slug ? getBuiltinTemplate(row.template_slug) : null]),
  );
  return deriveRecordLinks(steps, (id) => templates.get(id) ?? null);
}
