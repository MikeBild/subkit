// An approval follows a workflow to a newer version when that version reaches
// nothing the person did not already approve.
//
// A person approves an effect boundary for an environment: which connectors a
// workflow reaches, at which addresses, and whether it only reads or also
// writes. A saved change that keeps inside that boundary — a different
// transform, a renamed step, a narrower request — does not change the risk the
// person accepted, so asking again only teaches people to click "approve".
// When a version becomes active, each live approval of the version it replaces
// is compared with the new version's boundary, computed by the same function
// the grant dialog shows and admission checks (`previewWorkflowAuthority`):
//
//   * equal or narrower — a new approval for the new version takes over what is
//     left (runs, end date, environment), records where it came from, and the
//     old approval ends in the same transaction, so nothing is ever doubled;
//   * wider — nothing is carried; the version waits for a person as before and
//     the version row records what is new, for the attention list to say.
//
// Pending drafts are never touched: only activation carries an approval.

import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { Executor } from "../db/client.ts";
import {
  connectors,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import type { BoundaryGrowth } from "./authority-growth.ts";
import { authorityLive } from "./authority-live.ts";
import { contentBoundariesFromManifest } from "./content-publication-proposal.ts";
import { type WorkflowEffectManifest, WorkflowEffectManifestSchema } from "./effect-manifest.ts";
import { previewWorkflowAuthority } from "./execution-authorities.ts";
import { reportBoundariesFromManifest } from "./report-delivery-proposal.ts";

type Effect = WorkflowEffectManifest["effects"][number];

/** Adds each connector's display name, so a reader can say "new target: X". */
export async function nameGrowth(
  db: Executor,
  tenant_id: string,
  growth: BoundaryGrowth[],
): Promise<BoundaryGrowth[]> {
  const ids = [
    ...new Set(growth.flatMap((entry) => (entry.connector_id ? [entry.connector_id] : []))),
  ];
  if (ids.length === 0) return growth.map((entry) => ({ ...entry, connector_name: null }));
  const rows = await db
    .select({ id: connectors.id, name: connectors.display_name })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenant_id), inArray(connectors.id, ids)));
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return growth.map((entry) => ({
    ...entry,
    connector_name: entry.connector_id ? (names.get(entry.connector_id) ?? null) : null,
  }));
}

/** The approval a version's boundary is measured against for display: the
 *  newest one in this environment for another version of the workflow that a
 *  person did not revoke (a carried-over one counts — its boundary is the one
 *  a person approved). Null when there is none. */
export async function referenceApprovedManifest(
  db: Executor,
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
  },
): Promise<WorkflowEffectManifest | null> {
  const [row] = await db
    .select({
      approved: workflowExecutionAuthorities.approved_manifest,
      own: workflowExecutionAuthorities.effect_manifest,
    })
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, input.tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, input.workflow_id),
        ne(workflowExecutionAuthorities.workflow_version_id, input.workflow_version_id),
        eq(workflowExecutionAuthorities.execution_environment, input.execution_environment),
        or(
          isNull(workflowExecutionAuthorities.revoked_at),
          isNotNull(workflowExecutionAuthorities.superseded_by),
        ),
      ),
    )
    .orderBy(desc(workflowExecutionAuthorities.created_at), desc(workflowExecutionAuthorities.id))
    .limit(1);
  return row ? parseManifest(row.approved ?? row.own) : null;
}

const EFFECT_RANK = { read: 0, write: 1, destructive: 2 } as const;

/** Whether `granted` allows at least what `next` does. `unknown` is only
 *  covered by `unknown` on the same operation: the engine cannot order it. */
function effectCovered(next: Effect, granted: Effect): boolean {
  if (next.effect === "unknown" || granted.effect === "unknown")
    return next.effect === granted.effect && next.operation === granted.operation;
  return EFFECT_RANK[next.effect] <= EFFECT_RANK[granted.effect];
}

const SUB_BOUNDARIES = [
  "report_delivery",
  "content_publication",
  "read_path",
  "storage",
  "boundary",
  "read_query",
] as const;

function sameConfiguration(next: Effect, granted: Effect): boolean {
  return (
    next.configuration_digest === granted.configuration_digest &&
    next.credential_binding_digest === granted.credential_binding_digest &&
    next.rewrites_target === granted.rewrites_target &&
    SUB_BOUNDARIES.every((key) => isDeepStrictEqual(next[key], granted[key]))
  );
}

/**
 * What `next` reaches beyond `granted`; empty when it reaches nothing new.
 * Step ids, request digests and version identities are deliberately not
 * compared — they change with every edit and say nothing about the risk.
 */
export function boundaryGrowth(
  granted: WorkflowEffectManifest,
  next: WorkflowEffectManifest,
): BoundaryGrowth[] {
  const growth = new Map<string, BoundaryGrowth>();
  const add = (kind: BoundaryGrowth["kind"], effect: Effect) => {
    const entry = {
      kind,
      connector_id: effect.connector_id,
      target: effect.target,
      effect: effect.effect,
    };
    growth.set(JSON.stringify(entry), entry);
  };
  for (const effect of next.effects) {
    const sameConnector = granted.effects.filter(
      (candidate) =>
        candidate.connector_id === effect.connector_id &&
        candidate.driver === effect.driver &&
        candidate.environment === effect.environment,
    );
    if (sameConnector.length === 0) {
      add(effect.connector_id ? "new_connector" : "new_target", effect);
      continue;
    }
    const sameTarget = sameConnector.filter((candidate) => candidate.target === effect.target);
    if (sameTarget.length === 0) {
      add("new_target", effect);
      continue;
    }
    const sameShape = sameTarget.filter((candidate) => sameConfiguration(effect, candidate));
    if (sameShape.length === 0) {
      add("changed_boundary", effect);
      continue;
    }
    if (!sameShape.some((candidate) => effectCovered(effect, candidate)))
      add("wider_effect", effect);
  }
  return [...growth.values()];
}

function parseManifest(raw: unknown): WorkflowEffectManifest | null {
  const parsed = WorkflowEffectManifestSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type AuthorityRow = typeof workflowExecutionAuthorities.$inferSelect;

/** One approval measured against a version: its boundary, what that approval
 *  covers, and what the version adds. Null when the version cannot run on any
 *  approval (it needs a concrete-run review; the gate says why). */
async function judgeCarry(db: Executor, parent: AuthorityRow, to_version_id: string) {
  // A report mail's or a publication's boundary is learnt once and kept on the
  // approval; the new version has no approval of its own yet, so it is
  // measured with the ones its parent carries — exactly what admission reads
  // back from the carried approval afterwards.
  const report_boundaries = reportBoundariesFromManifest(parent.effect_manifest);
  const content_boundaries = contentBoundariesFromManifest(parent.effect_manifest);
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: parent.tenant_id,
      workflow_id: parent.workflow_id,
      workflow_version_id: to_version_id,
      execution_environment: parent.execution_environment,
    },
    db,
    {
      ...(Object.keys(report_boundaries).length > 0 ? { report_boundaries } : {}),
      ...(Object.keys(content_boundaries).length > 0 ? { content_boundaries } : {}),
    },
  );
  if (!preview.eligible_for_repeated_runs) return null;
  const granted = parseManifest(parent.approved_manifest ?? parent.effect_manifest);
  if (!granted) return null;
  return { preview, granted, growth: boundaryGrowth(granted, preview.manifest) };
}

/**
 * Whether activating `version_id` would carry a live approval of the active
 * version in this environment over — the same judgement activation makes, so
 * a review can offer "take over" instead of asking for a new approval.
 */
export async function approvalWouldCarry(
  db: Executor,
  input: {
    tenant_id: string;
    workflow_id: string;
    version_id: string;
    execution_environment: "dev" | "prod";
  },
): Promise<boolean> {
  const [workflow] = await db
    .select({ current: workflows.current_version_id, lifecycle: workflows.lifecycle })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, input.tenant_id), eq(workflows.id, input.workflow_id)))
    .limit(1);
  if (!workflow?.current || workflow.current === input.version_id) return false;
  const parents = await db
    .select()
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, input.tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, input.workflow_id),
        eq(workflowExecutionAuthorities.workflow_version_id, workflow.current),
        eq(workflowExecutionAuthorities.execution_environment, input.execution_environment),
        authorityLive(),
      ),
    );
  for (const parent of parents) {
    const judged = await judgeCarry(db, parent, input.version_id);
    if (judged && judged.growth.length === 0) return true;
  }
  return false;
}

/**
 * Called in the transaction that makes `to_version_id` the active version.
 * Runs in a savepoint: a failure here never undoes the save — the version then
 * simply waits for a person, which is the behaviour without inheritance.
 *
 * Exactly once: each parent row is locked with `FOR UPDATE` and re-read as
 * live; a concurrent activation waits on the lock, then finds it ended. The
 * unique index on `inherited_from` backs this up in the database.
 */
export async function carryApprovalsForward(
  tx: Executor,
  input: {
    tenant_id: string;
    workflow_id: string;
    from_version_id: string | null;
    to_version_id: string;
    actor_id: string | null;
  },
): Promise<{ inherited: string[]; growth: Partial<Record<"dev" | "prod", BoundaryGrowth[]>> }> {
  const outcome = {
    inherited: [] as string[],
    growth: {} as Partial<Record<"dev" | "prod", BoundaryGrowth[]>>,
  };
  if (!input.from_version_id || input.from_version_id === input.to_version_id) return outcome;
  const from_version_id = input.from_version_id;
  try {
    await tx.transaction(async (sp) => {
      const parents = await sp
        .select()
        .from(workflowExecutionAuthorities)
        .where(
          and(
            eq(workflowExecutionAuthorities.tenant_id, input.tenant_id),
            eq(workflowExecutionAuthorities.workflow_id, input.workflow_id),
            eq(workflowExecutionAuthorities.workflow_version_id, from_version_id),
            authorityLive(),
          ),
        )
        .orderBy(asc(workflowExecutionAuthorities.created_at), asc(workflowExecutionAuthorities.id))
        .for("update");
      if (parents.length === 0) return;
      const covered = new Set<"dev" | "prod">();
      for (const parent of parents) {
        const environment = parent.execution_environment;
        const judged = await judgeCarry(sp, parent, input.to_version_id);
        if (!judged) continue;
        const { preview, granted, growth } = judged;
        if (growth.length > 0) {
          outcome.growth[environment] = [...(outcome.growth[environment] ?? []), ...growth];
          continue;
        }
        const targets = [
          ...new Set(
            preview.manifest.effects.flatMap((effect) => (effect.target ? [effect.target] : [])),
          ),
        ].sort();
        const remaining =
          parent.max_runs === null ? null : Math.max(0, parent.max_runs - parent.reserved_runs);
        if (remaining === 0) continue;
        const [child] = await sp
          .insert(workflowExecutionAuthorities)
          .values({
            tenant_id: input.tenant_id,
            workflow_id: input.workflow_id,
            workflow_version_id: input.to_version_id,
            effect_manifest_digest: preview.digest,
            effect_manifest: { ...preview.manifest },
            execution_environment: environment,
            target_constraints: { targets },
            valid_from: sql`clock_timestamp()`,
            valid_until: parent.valid_until,
            max_runs: remaining,
            // The person who approved the boundary, not whoever saved.
            created_by: parent.created_by,
            inherited_from: parent.id,
            approved_manifest: { ...granted },
          })
          .returning();
        if (!child) throw new Error("inherited authority insert returned no row");
        await sp
          .update(workflowExecutionAuthorities)
          .set({
            revoked_at: sql`clock_timestamp()`,
            revoked_by: input.actor_id,
            superseded_by: child.id,
          })
          .where(
            and(
              eq(workflowExecutionAuthorities.tenant_id, input.tenant_id),
              eq(workflowExecutionAuthorities.id, parent.id),
            ),
          );
        const metadata = {
          workflow_id: input.workflow_id,
          inherited_from: parent.id,
          previous_version_id: from_version_id,
          workflow_version_id: input.to_version_id,
          execution_environment: environment,
          effect_manifest_digest: preview.digest,
          max_runs: remaining,
          valid_until: parent.valid_until?.toISOString() ?? null,
        };
        await auditAwait(
          {
            tenant_id: input.tenant_id,
            actor_type: input.actor_id ? "user" : "system",
            actor_id: input.actor_id,
            action: AuditAction.WORKFLOW_AUTHORITY_INHERITED,
            resource_type: "workflow_execution_authority",
            resource_id: child.id,
            result: "success",
            metadata,
          },
          sp,
        );
        logger.info({
          module: "workflows",
          action: "authority.inherited",
          msg: "approval carried over to the new active version; its boundary did not grow",
          tenant_id: input.tenant_id,
          execution_authority_id: child.id,
          ...metadata,
        });
        outcome.inherited.push(child.id);
        covered.add(environment);
      }
      // What the version adds, for the attention item. Only environments in
      // which no approval followed are named: one carried approval covers it.
      for (const environment of covered) delete outcome.growth[environment];
      for (const environment of ["dev", "prod"] as const) {
        const entries = outcome.growth[environment];
        if (entries) outcome.growth[environment] = await nameGrowth(sp, input.tenant_id, entries);
      }
      const growth = outcome.growth;
      if (Object.keys(growth).length > 0)
        await sp
          .update(workflowVersions)
          .set({ authority_growth: growth })
          .where(
            and(
              eq(workflowVersions.tenant_id, input.tenant_id),
              eq(workflowVersions.id, input.to_version_id),
            ),
          );
    });
  } catch (error) {
    logger.warn({
      module: "workflows",
      action: "authority.inheritance_failed",
      msg: "approval could not be carried to the new active version; it waits for a person",
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      workflow_version_id: input.to_version_id,
      err: error instanceof Error ? error.message : String(error),
    });
    return { inherited: [], growth: {} };
  }
  return outcome;
}
