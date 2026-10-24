import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { executions } from "../db/schema/executions.ts";
import {
  intakeItemEvidence,
  intakeItems,
  intakeProposalItems,
  intakeProposalRevisions,
  intakeProposals,
} from "../db/schema/intake.ts";
import { skillEffectiveness } from "../db/schema/skills.ts";
import { log } from "../logging/logger.ts";
import { now } from "../utils/clock.ts";
import { CORRECTION_AGENT } from "./correction-intake.ts";

const WINDOW_DAYS = 14;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const MAX_PROPOSALS_PER_PASS = 200;

interface AdmittedCorrection {
  proposal_id: string;
  skill_id: string;
  confirmed_at: Date;
  item_ids: string[];
  workflow_ids: string[];
}

export interface CorrectionEffectivenessReport {
  measured: number;
}

async function admittedCorrections(tenant_id: string, db: Db): Promise<AdmittedCorrection[]> {
  const openSince = new Date(now() - WINDOW_MS);
  const rows = await db
    .select({
      proposal_id: intakeProposals.id,
      skill_id: intakeProposals.confirmed_target_id,
      confirmed_at: intakeProposals.updated_at,
      item_id: intakeItems.id,
      workflow_id: sql<string | null>`${intakeItems.original_snapshot} ->> 'workflow_id'`,
    })
    .from(intakeProposals)
    .innerJoin(
      intakeProposalRevisions,
      and(
        eq(intakeProposalRevisions.proposal_id, intakeProposals.id),
        eq(intakeProposalRevisions.revision, intakeProposals.confirmed_revision),
        eq(intakeProposalRevisions.tenant_id, tenant_id),
      ),
    )
    .innerJoin(
      intakeProposalItems,
      and(
        eq(intakeProposalItems.proposal_revision_id, intakeProposalRevisions.id),
        eq(intakeProposalItems.tenant_id, tenant_id),
      ),
    )
    .innerJoin(
      intakeItems,
      and(eq(intakeItems.id, intakeProposalItems.item_id), eq(intakeItems.tenant_id, tenant_id)),
    )
    .where(
      and(
        eq(intakeProposals.tenant_id, tenant_id),
        eq(intakeProposals.status, "confirmed"),
        eq(intakeProposals.confirmed_target_kind, "skill"),
        gte(intakeProposals.updated_at, openSince),
        sql`${intakeItems.original_snapshot} ->> 'agent' = ${CORRECTION_AGENT}`,
      ),
    )
    .orderBy(intakeProposals.updated_at, intakeProposals.id)
    .limit(MAX_PROPOSALS_PER_PASS * 10);
  const byProposal = new Map<string, AdmittedCorrection>();
  for (const row of rows) {
    if (!row.skill_id) continue;
    const entry = byProposal.get(row.proposal_id) ?? {
      proposal_id: row.proposal_id,
      skill_id: row.skill_id,
      confirmed_at: row.confirmed_at,
      item_ids: [],
      workflow_ids: [],
    };
    entry.item_ids.push(row.item_id);
    if (row.workflow_id && !entry.workflow_ids.includes(row.workflow_id))
      entry.workflow_ids.push(row.workflow_id);
    byProposal.set(row.proposal_id, entry);
  }
  return [...byProposal.values()].slice(0, MAX_PROPOSALS_PER_PASS);
}

async function executionsBetween(
  tenant_id: string,
  workflow_ids: string[],
  from: Date,
  to: Date,
  db: Db,
): Promise<number> {
  const tenantConds = [
    eq(executions.tenant_id, tenant_id),
    gte(executions.started_at, from),
    lt(executions.started_at, to),
  ];
  if (workflow_ids.length > 0) tenantConds.push(inArray(executions.workflow_id, workflow_ids));
  const [row] = await db
    .select({ total: count() })
    .from(executions)
    .where(and(...tenantConds));
  return Number(row?.total ?? 0);
}

async function recurrencesBetween(
  tenant_id: string,
  item_ids: string[],
  from: Date,
  to: Date,
  db: Db,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(intakeItemEvidence)
    .where(
      and(
        eq(intakeItemEvidence.tenant_id, tenant_id),
        inArray(intakeItemEvidence.item_id, item_ids),
        gte(intakeItemEvidence.captured_at, from),
        lt(intakeItemEvidence.captured_at, to),
      ),
    );
  return Number(row?.total ?? 0);
}

export async function measureCorrectionEffectiveness(
  tenant_id: string,
  db: Db,
): Promise<CorrectionEffectivenessReport> {
  const admitted = await admittedCorrections(tenant_id, db);
  const current = new Date(now());
  for (const correction of admitted) {
    const window_start = new Date(correction.confirmed_at.getTime() - WINDOW_MS);
    const window_end = new Date(correction.confirmed_at.getTime() + WINDOW_MS);
    const afterEnd = current < window_end ? current : window_end;
    const [executionsBefore, executionsAfter, failuresBefore, failuresAfter] = await Promise.all([
      executionsBetween(
        tenant_id,
        correction.workflow_ids,
        window_start,
        correction.confirmed_at,
        db,
      ),
      executionsBetween(tenant_id, correction.workflow_ids, correction.confirmed_at, afterEnd, db),
      recurrencesBetween(tenant_id, correction.item_ids, window_start, correction.confirmed_at, db),
      recurrencesBetween(tenant_id, correction.item_ids, correction.confirmed_at, afterEnd, db),
    ]);
    const measured = {
      window_start,
      window_end,
      executions_before: executionsBefore,
      failures_before: failuresBefore,
      executions_after: executionsAfter,
      failures_after: failuresAfter,
    };
    await db
      .insert(skillEffectiveness)
      .values({
        tenant_id,
        skill_id: correction.skill_id,
        intake_proposal_id: correction.proposal_id,
        ...measured,
      })
      .onConflictDoUpdate({
        target: [
          skillEffectiveness.tenant_id,
          skillEffectiveness.skill_id,
          skillEffectiveness.intake_proposal_id,
        ],
        set: measured,
      });
  }
  if (admitted.length > 0)
    log.info({
      module: "skill",
      action: "correction_effectiveness.measured",
      msg: "effect of admitted corrections measured",
      tenant_id,
      measured: admitted.length,
    });
  return { measured: admitted.length };
}
