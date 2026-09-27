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
import {
  executionFixtures,
  patchCandidates,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { type PatchProposal, PatchProposalSchema } from "../llm/flows/repair.ts";
import { type PatchReadiness, readPatchReadiness } from "./candidate-readiness.ts";
import { runFixtureDryRun } from "./fixture-runner.ts";
import { applyPatchToWorkflowDag } from "./patch-apply.ts";
import { buildDryRunStep, loadStepSnapshot, resolveCandidateStepKey } from "./step-snapshot.ts";
import type { DryRunStep } from "./types.ts";

interface CandidateDiffEnvelope {
  proposal: PatchProposal | null;
  drift_diff: string | null;
  /** Raw envelope, kept so the step anchor resolves exactly as the apply path does. */
  raw: Record<string, unknown>;
  step_id: string | null;
  dry_run: Record<string, unknown> | null;
}

function readCandidateDiff(diff: unknown): CandidateDiffEnvelope {
  const obj = diff && typeof diff === "object" ? (diff as Record<string, unknown>) : {};
  const parsed = PatchProposalSchema.safeParse(obj.proposal);
  return {
    proposal: parsed.success ? parsed.data : null,
    drift_diff: typeof obj.drift_diff === "string" ? obj.drift_diff : null,
    raw: obj,
    step_id: typeof obj.step_id === "string" ? obj.step_id : null,
    dry_run:
      obj.dry_run && typeof obj.dry_run === "object"
        ? (obj.dry_run as Record<string, unknown>)
        : null,
  };
}

/**
 * Project a persisted DAG step down to the projection slots the review surface
 * renders. The wire shape stays `{id, kind, data_selector?, expression?}` — a
 * step definition carries connector ids, headers and bodies the operator does
 * not need in a before/after diff.
 */
function projectStep(step: Record<string, unknown>): DryRunStep | null {
  const id = typeof step.id === "string" ? step.id : null;
  const kind = step.kind === "transform" ? "transform" : step.kind === "request" ? "request" : null;
  if (!id || !kind) return null;
  const projected: DryRunStep = { id, kind };
  if (typeof step.data_selector === "string") projected.data_selector = step.data_selector;
  if (typeof step.expression === "string") projected.expression = step.expression;
  return projected;
}

/**
 * Load the step the patch targets out of the workflow's CURRENT version —
 * the same definition the apply path rewrites. Reading the failing
 * execution-step row instead would show the operator a step that carries no
 * `data_selector` at all, so the diff would promise a change the apply path
 * never makes.
 */
async function loadTargetStep(
  tenant_id: string,
  workflow_id: string,
  diff: Record<string, unknown>,
  db: Db,
): Promise<{ dag: unknown; step_key: string } | null> {
  const step_key = await resolveCandidateStepKey(tenant_id, diff, db);
  if (!step_key) return null;

  const rows = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflows.current_version_id, workflowVersions.id))
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow_id)))
    .limit(1);
  const dag = rows[0]?.dag;
  if (dag === undefined) return null;
  return { dag, step_key };
}

export interface PatchCandidatePreview extends PatchReadiness {
  candidate_id: string;
  workflow_id: string;
  classification: "safe" | "unsafe";
  status: "proposed" | "applied" | "rejected" | "superseded" | "inapplicable";
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

  // Before/after come from the workflow definition and the SAME pure rewrite
  // the apply path runs, so what the operator approves is what goes live.
  let before_step: DryRunStep | null = null;
  let after_step: DryRunStep | null = null;
  let changed_paths: string[] = [];
  const target = await loadTargetStep(tenant_id, row.workflow_id, envelope.raw, db);
  if (target) {
    const steps = Array.isArray((target.dag as Record<string, unknown>)?.steps)
      ? ((target.dag as Record<string, unknown>).steps as Record<string, unknown>[])
      : [];
    const current = steps.find((s) => s && typeof s === "object" && s.id === target.step_key);
    if (current) before_step = projectStep(current);
    if (before_step && envelope.proposal) {
      const patched = applyPatchToWorkflowDag(target.dag, target.step_key, envelope.proposal);
      if (patched.ok) {
        after_step = projectStep(patched.after);
        changed_paths = patched.changed_paths;
      }
    }
  }

  return {
    ...(await readPatchReadiness(tenant_id, row, db)),
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
    changed_paths,
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
