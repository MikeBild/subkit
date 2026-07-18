// Operator-facing patch-candidate review surface.
//
// `previewPatchCandidate` renders the human-readable before/after view
// the approve decision needs; `dryRunPatchCandidate` replays the patch
// against a recorded fixture (or one synthesized from the failing
// step's persisted material) WITHOUT mutating candidate status — the
// propose-never-auto-apply boundary stays intact.

import { and, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { type Db, getDb } from "../db/client.ts";
import { executionFixtures, patchCandidates } from "../db/schema/index.ts";
import { type PatchProposal, PatchProposalSchema } from "../llm/flows/repair.ts";
import { applyPatchToStep, runFixtureDryRun } from "./fixture-runner.ts";
import { buildDryRunStep, loadStepSnapshot } from "./step-snapshot.ts";
import type { DryRunStep } from "./types.ts";

interface CandidateDiffEnvelope {
  proposal: PatchProposal | null;
  drift_diff: string | null;
  step_id: string | null;
  dry_run: Record<string, unknown> | null;
}

function readCandidateDiff(diff: unknown): CandidateDiffEnvelope {
  const obj = diff && typeof diff === "object" ? (diff as Record<string, unknown>) : {};
  const parsed = PatchProposalSchema.safeParse(obj.proposal);
  return {
    proposal: parsed.success ? parsed.data : null,
    drift_diff: typeof obj.drift_diff === "string" ? obj.drift_diff : null,
    step_id: typeof obj.step_id === "string" ? obj.step_id : null,
    dry_run:
      obj.dry_run && typeof obj.dry_run === "object"
        ? (obj.dry_run as Record<string, unknown>)
        : null,
  };
}

/** Deterministic flat-object diff over the DryRunStep shape. Pure —
 *  unit-tested directly. */
export function diffStepPaths(before: DryRunStep, after: DryRunStep): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of [...keys].sort()) {
    const b = (before as unknown as Record<string, unknown>)[key];
    const a = (after as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)) changed.push(key);
  }
  return changed;
}

export interface PatchCandidatePreview {
  candidate_id: string;
  workflow_id: string;
  classification: "safe" | "unsafe";
  status: "proposed" | "applied" | "rejected" | "superseded";
  drift_summary: string | null;
  proposal: PatchProposal | null;
  fixture_available: boolean;
  /** The dry-run verdict recorded at proposal time (may be skipped). */
  proposal_dry_run: Record<string, unknown> | null;
  before_step: DryRunStep | null;
  after_step: DryRunStep | null;
  changed_paths: string[];
}

export async function previewPatchCandidate(
  tenant_id: string,
  candidate_id: string,
  exec?: Db,
): Promise<PatchCandidatePreview | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(patchCandidates)
    .where(and(eq(patchCandidates.tenant_id, tenant_id), eq(patchCandidates.id, candidate_id)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const envelope = readCandidateDiff(row.diff);

  let before_step: DryRunStep | null = null;
  let after_step: DryRunStep | null = null;
  if (envelope.step_id) {
    const snapshot = await loadStepSnapshot(tenant_id, envelope.step_id, db);
    if (snapshot) before_step = buildDryRunStep(snapshot);
  }
  if (before_step && envelope.proposal) {
    after_step = applyPatchToStep(before_step, envelope.proposal);
  }

  return {
    candidate_id: row.id,
    workflow_id: row.workflow_id,
    classification: row.classification,
    status: row.status,
    drift_summary: envelope.drift_diff,
    proposal: envelope.proposal,
    fixture_available: row.fixture_id !== null,
    proposal_dry_run: envelope.dry_run,
    before_step,
    after_step,
    changed_paths: before_step && after_step ? diffStepPaths(before_step, after_step) : [],
  };
}

export type CandidateDryRunOutcome =
  | {
      status: "ran";
      ok: boolean;
      error: string | null;
      value_preview: unknown;
      fixture_source: "recorded" | "synthesized";
    }
  | { status: "not_found" }
  | { status: "no_proposal" }
  | { status: "no_step" }
  | { status: "no_fixture" };

export async function dryRunPatchCandidate(
  params: { tenant_id: string; candidate_id: string; actor_id: string | null },
  exec?: Db,
): Promise<CandidateDryRunOutcome> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(patchCandidates)
    .where(
      and(
        eq(patchCandidates.tenant_id, params.tenant_id),
        eq(patchCandidates.id, params.candidate_id),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return { status: "not_found" };
  const envelope = readCandidateDiff(row.diff);
  if (!envelope.proposal) return { status: "no_proposal" };
  if (!envelope.step_id) return { status: "no_step" };

  const snapshot = await loadStepSnapshot(params.tenant_id, envelope.step_id, db);
  if (!snapshot) return { status: "no_step" };
  const step = buildDryRunStep(snapshot);

  // Prefer the fixture recorded at proposal time; otherwise synthesize
  // one from the failing step's persisted request/response material —
  // exactly what the repair flow itself consumed.
  let fixture: { request: unknown; response: unknown } | null = null;
  let fixture_source: "recorded" | "synthesized" = "recorded";
  if (row.fixture_id) {
    const fixtureRows = await db
      .select()
      .from(executionFixtures)
      .where(
        and(
          eq(executionFixtures.tenant_id, params.tenant_id),
          eq(executionFixtures.id, row.fixture_id),
        ),
      )
      .limit(1);
    const f = fixtureRows[0];
    if (f) fixture = { request: f.request, response: f.response };
  }
  if (!fixture && snapshot.output_preview != null) {
    fixture = { request: snapshot.request_meta, response: snapshot.output_preview };
    fixture_source = "synthesized";
  }
  if (!fixture) return { status: "no_fixture" };

  const result = await runFixtureDryRun({ step, patch: envelope.proposal, fixture });

  // Read-only from the candidate's perspective, but it executes a
  // tenant-supplied projection — leave an audit trace.
  await auditAwait(
    {
      tenant_id: params.tenant_id,
      actor_type: params.actor_id ? "user" : "system",
      actor_id: params.actor_id,
      action: AuditAction.PATCH_CANDIDATE_DRY_RUN_REQUESTED,
      resource_type: "patch_candidate",
      resource_id: params.candidate_id,
      result: "success",
      metadata: { ok: result.ok, fixture_source, error: result.error ?? null },
    },
    db,
  );

  return {
    status: "ran",
    ok: result.ok,
    error: result.error ?? null,
    value_preview: result.value ?? null,
    fixture_source,
  };
}
