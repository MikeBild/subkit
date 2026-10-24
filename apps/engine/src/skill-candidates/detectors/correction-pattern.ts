import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  auditLog,
  conversations,
  conversationToolCalls,
  executionSteps,
  executions,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { now } from "../../utils/clock.ts";

const LOOKBACK_DAYS = 30;
const MAX_ROWS_PER_SOURCE = 500;
const REASON_MAX_CHARS = 300;
const MISSING_MAX_ENTRIES = 8;
const STEP_LIST_MAX_ENTRIES = 12;
const AUTHORING_SAVE_SOURCE = "tool-chain";
const JUDGE_VERDICTS = ["partial", "failed"] as const;

export type CorrectionKind = "judge_verdict" | "transform_error" | "user_edit";

export interface CorrectionObservation {
  kind: CorrectionKind;
  workflow_id: string | null;
  title: string;
  body: string;
  occurrence_id: string;
  excerpt: string;
  captured_at: Date;
}

type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];

const UNSAVED_DRAFT_LABEL = "unsaved workflow drafts";

function workflowLabel(name: string | null): string {
  return name ? `'${name}'` : UNSAVED_DRAFT_LABEL;
}

function textList(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").slice(0, max)
    : [];
}

function judgeObservation(row: {
  tool_call_id: string;
  conversation_id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  verdict: JudgeVerdict;
  reason: string | null;
  missing: unknown;
  created_at: Date;
}): CorrectionObservation {
  const label = workflowLabel(row.workflow_name);
  const missing = textList(row.missing, MISSING_MAX_ENTRIES);
  const reason = (row.reason ?? "").slice(0, REASON_MAX_CHARS);
  return {
    kind: "judge_verdict",
    workflow_id: row.workflow_id,
    title: `Preview judge rated ${label} ${row.verdict}`,
    body: `The preview judge rated a dry run of ${label} as '${row.verdict}': the preview output did not fully satisfy the goal the person stated. Each evidence entry names the conversation, the judge's reason and what was missing. Review whether a skill rule would let authoring meet the goal on the first preview.`,
    occurrence_id: `conversation:${row.conversation_id}`,
    excerpt: [
      `verdict=${row.verdict}`,
      `conversation=${row.conversation_id}`,
      `tool_call=${row.tool_call_id}`,
      ...(missing.length > 0 ? [`missing: ${missing.join("; ")}`] : []),
      ...(reason ? [`reason: ${reason}`] : []),
    ].join("\n"),
    captured_at: row.created_at,
  };
}

async function judgeObservations(
  tenant_id: string,
  db: Db,
  cutoff: Date,
): Promise<CorrectionObservation[]> {
  const verdict = sql<string>`${conversationToolCalls.output} -> 'judge' ->> 'verdict'`;
  const rows = await db
    .select({
      tool_call_id: conversationToolCalls.id,
      conversation_id: conversationToolCalls.conversation_id,
      verdict,
      reason: sql<string | null>`${conversationToolCalls.output} -> 'judge' ->> 'reason'`,
      missing: sql<unknown>`${conversationToolCalls.output} -> 'judge' -> 'missing'`,
      created_at: conversationToolCalls.created_at,
      workflow_id: workflows.id,
      workflow_name: workflows.name,
    })
    .from(conversationToolCalls)
    .innerJoin(
      conversations,
      and(
        eq(conversations.id, conversationToolCalls.conversation_id),
        eq(conversations.tenant_id, tenant_id),
      ),
    )
    .leftJoin(
      workflows,
      and(eq(workflows.id, conversations.target_workflow_id), eq(workflows.tenant_id, tenant_id)),
    )
    .where(
      and(
        eq(conversationToolCalls.tenant_id, tenant_id),
        eq(conversationToolCalls.tool, "dry_run_workflow"),
        gte(conversationToolCalls.created_at, cutoff),
        inArray(verdict, [...JUDGE_VERDICTS]),
      ),
    )
    .orderBy(asc(conversationToolCalls.created_at), asc(conversationToolCalls.id))
    .limit(MAX_ROWS_PER_SOURCE);
  return rows.flatMap((row) =>
    row.verdict === "partial" || row.verdict === "failed"
      ? [judgeObservation({ ...row, verdict: row.verdict })]
      : [],
  );
}

async function transformObservations(
  tenant_id: string,
  db: Db,
  cutoff: Date,
): Promise<CorrectionObservation[]> {
  const rows = await db
    .select({
      step_id: executionSteps.id,
      execution_id: executionSteps.execution_id,
      step_key: executionSteps.step_key,
      code: sql<string | null>`${executionSteps.error} ->> 'code'`,
      started_at: executionSteps.started_at,
      created_at: executions.created_at,
      workflow_id: workflows.id,
      workflow_name: workflows.name,
    })
    .from(executionSteps)
    .innerJoin(
      executions,
      and(eq(executions.id, executionSteps.execution_id), eq(executions.tenant_id, tenant_id)),
    )
    .leftJoin(
      workflows,
      and(eq(workflows.id, executions.workflow_id), eq(workflows.tenant_id, tenant_id)),
    )
    .where(
      and(
        eq(executionSteps.tenant_id, tenant_id),
        eq(executionSteps.kind, "transform"),
        eq(executionSteps.status, "failed"),
        gte(executionSteps.started_at, cutoff),
      ),
    )
    .orderBy(asc(executionSteps.started_at), asc(executionSteps.id))
    .limit(MAX_ROWS_PER_SOURCE);
  return rows.map((row) => {
    const label = workflowLabel(row.workflow_name);
    const code = row.code ?? "unknown";
    return {
      kind: "transform_error" as const,
      workflow_id: row.workflow_id,
      title: `Transform step '${row.step_key}' fails at runtime in ${label} (${code})`,
      body: `The transform step '${row.step_key}' in ${label} failed at runtime with '${code}'. Each evidence entry names the execution. Review whether a skill rule about the data shape or the transform contract would prevent this error.`,
      occurrence_id: `execution:${row.execution_id}`,
      excerpt: [`code=${code}`, `step=${row.step_key}`, `execution=${row.execution_id}`].join("\n"),
      captured_at: row.started_at ?? row.created_at,
    };
  });
}

interface DraftSave {
  audit_id: string;
  ts: Date;
  actor_type: string;
  workflow_id: string;
  version: number | null;
  request_source: string | null;
}

interface StepShape {
  id: string;
  kind: string;
  canonical: string;
}

function stepsOf(dag: unknown): Map<string, StepShape> {
  const steps = new Map<string, StepShape>();
  const list = dag && typeof dag === "object" ? (dag as Record<string, unknown>).steps : null;
  if (!Array.isArray(list)) return steps;
  for (const step of list) {
    if (!step || typeof step !== "object") continue;
    const record = step as Record<string, unknown>;
    if (typeof record.id !== "string") continue;
    steps.set(record.id, {
      id: record.id,
      kind: typeof record.kind === "string" ? record.kind : "unknown",
      canonical: JSON.stringify(record),
    });
  }
  return steps;
}

export function changedStepSummary(before: unknown, after: unknown): string[] {
  const prior = stepsOf(before);
  const next = stepsOf(after);
  const label = (step: StepShape) => `${step.id} (${step.kind})`;
  const added = [...next.values()].filter((step) => !prior.has(step.id)).map(label);
  const removed = [...prior.values()].filter((step) => !next.has(step.id)).map(label);
  const changed = [...next.values()]
    .filter((step) => {
      const old = prior.get(step.id);
      return old !== undefined && old.canonical !== step.canonical;
    })
    .map(label);
  const line = (name: string, entries: string[]) =>
    entries.length > 0 ? [`${name}: ${entries.slice(0, STEP_LIST_MAX_ENTRIES).join(", ")}`] : [];
  return [...line("changed", changed), ...line("added", added), ...line("removed", removed)];
}

function correctedPairs(saves: DraftSave[]): Array<{ before: DraftSave; after: DraftSave }> {
  const pairs: Array<{ before: DraftSave; after: DraftSave }> = [];
  for (let i = 1; i < saves.length; i++) {
    const before = saves[i - 1];
    const after = saves[i];
    if (!before || !after || before.workflow_id !== after.workflow_id) continue;
    if (before.request_source !== AUTHORING_SAVE_SOURCE) continue;
    if (after.actor_type !== "user" || after.request_source === AUTHORING_SAVE_SOURCE) continue;
    pairs.push({ before, after });
  }
  return pairs;
}

async function userEditObservations(
  tenant_id: string,
  db: Db,
  cutoff: Date,
): Promise<CorrectionObservation[]> {
  const rows = await db
    .select({
      audit_id: auditLog.id,
      ts: auditLog.ts,
      actor_type: auditLog.actor_type,
      workflow_id: auditLog.resource_id,
      version: sql<number | null>`(${auditLog.metadata} ->> 'version')::int`,
      request_source: sql<string | null>`${auditLog.metadata} ->> 'request_source'`,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.resource_type, "workflow"),
        inArray(auditLog.action, ["workflow.created", "workflow.updated"]),
        eq(auditLog.result, "success"),
        sql`${auditLog.metadata} ->> 'kind' = 'draft'`,
        gte(auditLog.ts, cutoff),
      ),
    )
    .orderBy(asc(auditLog.resource_id), asc(auditLog.ts), asc(auditLog.id))
    .limit(MAX_ROWS_PER_SOURCE * 4);
  const saves = rows.flatMap((row): DraftSave[] =>
    row.workflow_id ? [{ ...row, workflow_id: row.workflow_id }] : [],
  );
  const pairs = correctedPairs(saves).slice(0, MAX_ROWS_PER_SOURCE);
  if (pairs.length === 0) return [];
  const workflowIds = [...new Set(pairs.map((pair) => pair.after.workflow_id))];
  const [names, versions] = await Promise.all([
    db
      .select({ id: workflows.id, name: workflows.name })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), inArray(workflows.id, workflowIds))),
    db
      .select({
        workflow_id: workflowVersions.workflow_id,
        version: workflowVersions.version,
        dag: workflowVersions.dag,
      })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, tenant_id),
          inArray(workflowVersions.workflow_id, workflowIds),
          inArray(workflowVersions.version, [
            ...new Set(
              pairs.flatMap((pair) =>
                [pair.before.version, pair.after.version].filter(
                  (version): version is number => typeof version === "number",
                ),
              ),
            ),
          ]),
        ),
      ),
  ]);
  const nameOf = new Map(names.map((row) => [row.id, row.name]));
  const dagOf = new Map(versions.map((row) => [`${row.workflow_id}:${row.version}`, row.dag]));
  return pairs.flatMap(({ before, after }) => {
    const name = nameOf.get(after.workflow_id);
    if (name === undefined) return [];
    const label = workflowLabel(name);
    const changes = changedStepSummary(
      dagOf.get(`${before.workflow_id}:${before.version}`),
      dagOf.get(`${after.workflow_id}:${after.version}`),
    );
    return [
      {
        kind: "user_edit" as const,
        workflow_id: after.workflow_id,
        title: `Person corrected ${label} after an authoring save`,
        body: `A person changed ${label} directly after authoring saved it. Each evidence entry names the versions and the steps the person changed. Review whether a skill rule would let authoring produce the corrected shape itself.`,
        occurrence_id: `audit:${after.audit_id}`,
        excerpt: [
          `versions=${before.version ?? "?"}->${after.version ?? "?"}`,
          `source=${after.request_source ?? "unknown"}`,
          ...changes,
        ].join("\n"),
        captured_at: after.ts,
      },
    ];
  });
}

export async function detectCorrectionPatterns(
  tenant_id: string,
  exec: Db,
): Promise<CorrectionObservation[]> {
  const cutoff = new Date(now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const [judge, transform, edits] = await Promise.all([
    judgeObservations(tenant_id, exec, cutoff),
    transformObservations(tenant_id, exec, cutoff),
    userEditObservations(tenant_id, exec, cutoff),
  ]);
  logger.debug({
    module: "skill",
    action: "detector.correction.result",
    msg: "correction pattern detector finished",
    tenant_id,
    judge_verdicts: judge.length,
    transform_errors: transform.length,
    user_edits: edits.length,
  });
  return [...judge, ...transform, ...edits].sort(
    (a, b) =>
      a.captured_at.getTime() - b.captured_at.getTime() ||
      a.occurrence_id.localeCompare(b.occurrence_id),
  );
}
