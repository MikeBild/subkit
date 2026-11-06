import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "../../logging/logger.ts";
import { authoringCapabilitySignal } from "../../skill-candidates/authoring-capability.ts";
import { detectFailurePatterns } from "../../skill-candidates/detectors/index.ts";
import { upsertFromSignal } from "../../skill-candidates/service.ts";
import type { Db } from "../client.ts";
import { dataMigrations, skillCandidates, workflows, workflowVersions } from "../schema/index.ts";

export const CONTEXT_NOTE_FACTS_BACKFILL_NAME = "context_note_facts";

export interface ContextNoteFactsBackfillReport {
  skipped: boolean;
  regenerated: number;
  dropped: number;
}

function factless() {
  return and(
    eq(skillCandidates.status, "context"),
    inArray(skillCandidates.pattern_kind, ["authoring_capability", "failure_pattern"]),
    sql`(${skillCandidates.examples} -> 'facts') IS NULL`,
  );
}

async function regenerateCapability(
  db: Db,
  note: { tenant_id: string; workflow_id: string | null },
): Promise<boolean> {
  if (!note.workflow_id) return false;
  const [workflow] = await db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      draft_version_id: workflows.draft_version_id,
      version_id: sql<
        string | null
      >`coalesce(${workflows.draft_version_id}, ${workflows.current_version_id})`,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, note.tenant_id),
        eq(workflows.id, note.workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  if (!workflow?.version_id) return false;
  const [version] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, note.tenant_id),
        eq(workflowVersions.id, workflow.version_id),
      ),
    )
    .limit(1);
  const dag = (version?.dag ?? null) as Record<string, unknown> | null;
  if (!dag) return false;
  const signal = authoringCapabilitySignal({
    workflow_id: workflow.id,
    slug: workflow.slug,
    name: workflow.name,
    def: {
      name: workflow.name,
      steps: Array.isArray(dag.steps) ? (dag.steps as Array<Record<string, unknown>>) : [],
      ...(dag.input_schema ? { input_schema: dag.input_schema as Record<string, unknown> } : {}),
      ...(dag.output_schema ? { output_schema: dag.output_schema as Record<string, unknown> } : {}),
    },
    scope_index: {},
    ...(workflow.draft_version_id ? { draft_version_id: workflow.draft_version_id } : {}),
  });
  const result = await upsertFromSignal(note.tenant_id, signal, db);
  return result.action !== "skipped";
}

export async function runContextNoteFactsBackfill(db: Db): Promise<ContextNoteFactsBackfillReport> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — boot data-migration ledger; markers are instance-global by design
    .where(eq(dataMigrations.name, CONTEXT_NOTE_FACTS_BACKFILL_NAME))
    .limit(1);
  if (marker.length > 0) return { skipped: true, regenerated: 0, dropped: 0 };

  const notes = await db
    .select({
      id: skillCandidates.id,
      tenant_id: skillCandidates.tenant_id,
      workflow_id: skillCandidates.workflow_id,
      pattern_kind: skillCandidates.pattern_kind,
    })
    .from(skillCandidates) // tenant-filter:exempt — cross-tenant boot backfill
    .where(factless());

  let regenerated = 0;
  for (const note of notes.filter((n) => n.pattern_kind === "authoring_capability"))
    if (await regenerateCapability(db, note)) regenerated += 1;

  const failureTenants = [
    ...new Set(notes.filter((n) => n.pattern_kind === "failure_pattern").map((n) => n.tenant_id)),
  ];
  for (const tenant_id of failureTenants)
    for (const signal of await detectFailurePatterns(tenant_id, db)) {
      const result = await upsertFromSignal(tenant_id, signal, db);
      if (result.action !== "skipped") regenerated += 1;
    }

  const dropped = await db
    .delete(skillCandidates) // tenant-filter:exempt — cross-tenant boot backfill
    .where(factless())
    .returning({ id: skillCandidates.id });

  await db
    .insert(dataMigrations)
    .values({ name: CONTEXT_NOTE_FACTS_BACKFILL_NAME })
    .onConflictDoNothing();

  logger.info({
    module: "db",
    action: "skill_candidate.context_facts_backfill.completed",
    msg: "context note facts backfill finished",
    regenerated,
    dropped: dropped.length,
  });

  return { skipped: false, regenerated, dropped: dropped.length };
}
