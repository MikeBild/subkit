import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import {
  executionSteps,
  executions,
  patchCandidates,
  workflowExecutionAuthorities,
} from "../db/schema/index.ts";

interface WorkflowHistoryScope {
  tenant_id: string;
  workflow_id: string;
  workflow_version_id: string;
  execution_environment: "dev" | "prod";
}

type RunFact = Pick<
  typeof executions.$inferSelect,
  "id" | "status" | "workflow_id" | "workflow_version_id" | "execution_mode"
>;
type StepFact = {
  execution_id: string;
  key: string;
  status: typeof executionSteps.$inferSelect.status;
  kind: typeof executionSteps.$inferSelect.kind;
  meta: typeof executionSteps.$inferSelect.request_meta;
};
type RefusalFact = {
  execution_id: string;
  step_id: string;
  error: typeof executionSteps.$inferSelect.error;
};
type ObservationFact = {
  execution_id: string;
  step_key: string;
  meta: typeof executionSteps.$inferSelect.request_meta;
};
type StorageFact = { step_key: string; key: string; at: Date };
type CandidateFact = Pick<typeof patchCandidates.$inferSelect, "id" | "status" | "diff">;

export interface WorkflowHistoryFacts {
  tenant_id: string;
  workflow_ids: ReadonlySet<string>;
  step_ids: ReadonlyMap<string, ReadonlySet<string>>;
  version_ids: ReadonlySet<string>;
  authorities: ReadonlyMap<string, { manifest: unknown }>;
  held: ReadonlyMap<string, RunFact>;
  successful_held: ReadonlyMap<string, RunFact>;
  steps: ReadonlyMap<string, readonly StepFact[]>;
  refused: ReadonlyMap<string, RefusalFact>;
  observations: ReadonlyMap<string, readonly ObservationFact[]>;
  storage: ReadonlyMap<string, readonly StorageFact[]>;
  candidates: ReadonlyMap<string, readonly CandidateFact[]>;
}

export function historyScopeKey(input: Omit<WorkflowHistoryScope, "tenant_id">): string {
  return JSON.stringify([
    input.workflow_id,
    input.workflow_version_id,
    input.execution_environment,
  ]);
}

export function historyStepKey(
  input: Omit<WorkflowHistoryScope, "tenant_id">,
  step_id: string,
): string {
  return JSON.stringify([historyScopeKey(input), step_id]);
}

export function assertHistoryScope(
  facts: WorkflowHistoryFacts,
  tenant_id: string,
  workflow_id: string,
): void {
  if (facts.tenant_id !== tenant_id || !facts.workflow_ids.has(workflow_id)) {
    throw new Error("Workflow history facts do not cover the requested tenant and workflow");
  }
}

const LOOP_SUFFIX = "\\[[0-9]+\\]$";

export function assertHistoryVersion(
  facts: WorkflowHistoryFacts,
  input: WorkflowHistoryScope,
): void {
  assertHistoryScope(facts, input.tenant_id, input.workflow_id);
  if (!facts.version_ids.has(input.workflow_version_id)) {
    throw new Error("Workflow history facts do not cover the requested version");
  }
}

export function assertHistoryStep(
  facts: WorkflowHistoryFacts,
  tenant_id: string,
  workflow_id: string,
  step_id: string,
): void {
  assertHistoryScope(facts, tenant_id, workflow_id);
  if (!facts.step_ids.get(workflow_id)?.has(step_id)) {
    throw new Error("Workflow history facts do not cover the requested step");
  }
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const entries = map.get(key);
  if (entries) entries.push(value);
  else map.set(key, [value]);
}

export async function loadWorkflowHistoryFacts(
  db: Executor,
  tenant_id: string,
  workflowIds: readonly string[],
  stepIdsByWorkflow: ReadonlyMap<string, readonly string[]>,
  versionIds: ReadonlySet<string>,
): Promise<WorkflowHistoryFacts> {
  const ids = [...new Set(workflowIds)];
  const step_ids = new Map(ids.map((id) => [id, new Set(stepIdsByWorkflow.get(id) ?? [])]));
  const authorities = new Map<string, { manifest: unknown }>();
  const held = new Map<string, RunFact>();
  const successful_held = new Map<string, RunFact>();
  const steps = new Map<string, StepFact[]>();
  const refused = new Map<string, RefusalFact>();
  const observations = new Map<string, ObservationFact[]>();
  const storage = new Map<string, StorageFact[]>();
  const candidates = new Map<string, CandidateFact[]>();
  const facts: WorkflowHistoryFacts = {
    tenant_id,
    workflow_ids: new Set(ids),
    step_ids,
    version_ids: new Set(versionIds),
    authorities,
    held,
    successful_held,
    steps,
    refused,
    observations,
    storage,
    candidates,
  };
  if (ids.length === 0) return facts;

  const authorityRows = await db.execute<{
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
    manifest: unknown;
  }>(sql`
    SELECT DISTINCT ON (workflow_id, workflow_version_id, execution_environment)
      workflow_id, workflow_version_id, execution_environment, effect_manifest AS manifest
    FROM ${workflowExecutionAuthorities}
    WHERE tenant_id = ${tenant_id} AND workflow_id = ANY(${sql.param(ids)}::uuid[])
      AND workflow_version_id = ANY(${sql.param([...versionIds])}::uuid[])
    ORDER BY workflow_id, workflow_version_id, execution_environment, created_at DESC, id DESC
  `);
  for (const row of authorityRows.rows)
    authorities.set(historyScopeKey(row), { manifest: row.manifest });

  const runRows = await db.execute<RunFact & { latest_rank: string; status_rank: string }>(sql`
    WITH ranked AS (
      SELECT id, status, workflow_id, workflow_version_id, execution_mode,
        row_number() OVER (PARTITION BY workflow_id, workflow_version_id, execution_mode ORDER BY created_at DESC, id DESC) AS latest_rank,
        row_number() OVER (PARTITION BY workflow_id, workflow_version_id, execution_mode, status ORDER BY created_at DESC, id DESC) AS status_rank
      FROM ${executions}
      WHERE tenant_id = ${tenant_id} AND workflow_id = ANY(${sql.param(ids)}::uuid[]) AND hold_writes = true
        AND workflow_version_id = ANY(${sql.param([...versionIds])}::uuid[])
    )
    SELECT * FROM ranked WHERE latest_rank = 1 OR (status = 'succeeded' AND status_rank = 1)
  `);
  for (const row of runRows.rows) {
    if (!row.workflow_id || !row.workflow_version_id) continue;
    const key = historyScopeKey({
      workflow_id: row.workflow_id,
      workflow_version_id: row.workflow_version_id,
      execution_environment: row.execution_mode,
    });
    if (Number(row.latest_rank) === 1) held.set(key, row);
    if (row.status === "succeeded" && Number(row.status_rank) === 1) successful_held.set(key, row);
  }
  const runIds = [...new Set([...held.values(), ...successful_held.values()].map((run) => run.id))];
  if (runIds.length > 0) {
    const rows = await db
      .select({
        execution_id: executionSteps.execution_id,
        key: executionSteps.step_key,
        status: executionSteps.status,
        kind: executionSteps.kind,
        meta: executionSteps.request_meta,
      })
      .from(executionSteps)
      .where(
        and(eq(executionSteps.tenant_id, tenant_id), inArray(executionSteps.execution_id, runIds)),
      );
    for (const row of rows) append(steps, row.execution_id, row);
  }

  const refusalRows = await db.execute<
    RefusalFact & {
      workflow_id: string;
      workflow_version_id: string;
      execution_environment: "dev" | "prod";
    }
  >(sql`
    WITH ranked AS (
      SELECT s.execution_id, regexp_replace(s.step_key, ${LOOP_SUFFIX}, '') AS step_id, s.error,
        e.workflow_id, e.workflow_version_id, e.execution_mode AS execution_environment,
        row_number() OVER (PARTITION BY e.workflow_id, e.workflow_version_id, e.execution_mode ORDER BY e.created_at DESC, s.started_at DESC) AS position
      FROM ${executionSteps} s
      JOIN ${executions} e ON e.id = s.execution_id AND e.tenant_id = s.tenant_id
      WHERE s.tenant_id = ${tenant_id} AND e.workflow_id = ANY(${sql.param(ids)}::uuid[])
        AND e.workflow_version_id = ANY(${sql.param([...versionIds])}::uuid[])
        AND e.execution_authority_id IS NOT NULL AND s.error->>'code' = 'execution_authority_changed'
        AND NOT EXISTS (
          SELECT 1 FROM ${executionSteps} later_step
          JOIN ${executions} later_run ON later_run.id = later_step.execution_id AND later_run.tenant_id = later_step.tenant_id
          WHERE later_step.tenant_id = s.tenant_id AND later_run.workflow_id = e.workflow_id
            AND later_run.workflow_version_id = e.workflow_version_id AND later_run.execution_mode = e.execution_mode
            AND later_run.execution_authority_id IS NOT NULL AND later_run.hold_writes = false
            AND later_run.id <> e.id AND later_run.created_at > e.created_at
            AND later_step.status = 'succeeded' AND later_step.held = false
            AND regexp_replace(later_step.step_key, ${LOOP_SUFFIX}, '') = regexp_replace(s.step_key, ${LOOP_SUFFIX}, '')
        )
    ) SELECT execution_id, step_id, error, workflow_id, workflow_version_id, execution_environment FROM ranked WHERE position = 1
  `);
  for (const row of refusalRows.rows) {
    refused.set(historyScopeKey(row), row);
    step_ids.get(row.workflow_id)?.add(row.step_id);
  }

  const targets = ids.flatMap((workflow_id) =>
    [...(step_ids.get(workflow_id) ?? [])].map((step_id) => ({
      workflow_id,
      step_id,
      pattern: `^${escapeRegex(step_id)}${LOOP_SUFFIX}`,
    })),
  );
  if (targets.length > 0) {
    const observationRows = await db.execute<
      ObservationFact & {
        workflow_id: string;
        workflow_version_id: string;
        execution_environment: "dev" | "prod";
        subject_step_id: string;
      }
    >(sql`
      WITH targets AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(targets)}::jsonb) AS t(workflow_id uuid, step_id text, pattern text)),
      ranked AS (
        SELECT s.execution_id, s.step_key, s.request_meta AS meta, e.workflow_id, e.workflow_version_id,
          e.execution_mode AS execution_environment, t.step_id AS subject_step_id,
          row_number() OVER (PARTITION BY e.workflow_id, e.workflow_version_id, e.execution_mode, t.step_id ORDER BY e.created_at DESC, s.started_at DESC) AS position
        FROM targets t JOIN ${executions} e ON e.workflow_id = t.workflow_id AND e.tenant_id = ${tenant_id}
        JOIN ${executionSteps} s ON s.execution_id = e.id AND s.tenant_id = e.tenant_id
        WHERE e.hold_writes = true AND e.workflow_version_id = ANY(${sql.param([...versionIds])}::uuid[]) AND (s.step_key = t.step_id OR s.step_key ~ t.pattern)
      ) SELECT execution_id, step_key, meta, workflow_id, workflow_version_id, execution_environment, subject_step_id
        FROM ranked WHERE position <= 20 ORDER BY workflow_id, workflow_version_id, execution_environment, subject_step_id, position
    `);
    for (const row of observationRows.rows)
      append(observations, historyStepKey(row, row.subject_step_id), row);

    const storageRows = await db.execute<
      Omit<StorageFact, "at"> & { workflow_id: string; at: string }
    >(sql`
      WITH targets AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(targets)}::jsonb) AS t(workflow_id uuid, step_id text)),
      ranked AS (
        SELECT e.workflow_id, s.step_key, s.request_meta->>'key' AS key, e.created_at AS at,
          row_number() OVER (PARTITION BY e.workflow_id, s.step_key ORDER BY e.created_at DESC) AS position
        FROM targets t JOIN ${executions} e ON e.workflow_id = t.workflow_id AND e.tenant_id = ${tenant_id}
        JOIN ${executionSteps} s ON s.execution_id = e.id AND s.tenant_id = e.tenant_id AND s.step_key = t.step_id
        WHERE s.status = 'succeeded' AND s.request_meta IS NOT NULL AND s.request_meta->>'key' IS NOT NULL
      ) SELECT workflow_id, step_key, key, at FROM ranked WHERE position <= 500 ORDER BY at DESC
    `);
    for (const row of storageRows.rows) {
      const at = new Date(row.at);
      if (!Number.isFinite(at.getTime()))
        throw new Error("Invalid workflow history observation time");
      append(storage, row.workflow_id, { step_key: row.step_key, key: row.key, at });
    }
  }

  const candidateRows = await db
    .select({
      workflow_id: patchCandidates.workflow_id,
      id: patchCandidates.id,
      status: patchCandidates.status,
      diff: patchCandidates.diff,
    })
    .from(patchCandidates)
    .where(
      and(
        eq(patchCandidates.tenant_id, tenant_id),
        inArray(patchCandidates.workflow_id, ids),
        sql`${patchCandidates.endpoint_key} LIKE 'gate:%'`,
        sql`${patchCandidates.diff}->>'base_version_id' = ANY(${sql.param([...versionIds])}::text[])`,
      ),
    )
    .orderBy(desc(patchCandidates.created_at), desc(patchCandidates.id));
  for (const row of candidateRows) append(candidates, row.workflow_id, row);
  return facts;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
