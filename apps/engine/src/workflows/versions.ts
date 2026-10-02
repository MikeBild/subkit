// A workflow's stored versions: the read-only history and the restore that
// makes one of them current again.
//
// History shows what was saved, as it was saved. The definition schema moves
// on; a version written under an earlier schema is still part of the record
// and must stay listable, so the list never parses a stored dag strictly — it
// only marks whether the version would still validate (`legacy`). Restore is
// the opposite: it makes a stored dag the live definition, so there the schema
// is enforced and a version that no longer validates is refused by name.
// Restore is additive: it duplicates the old version's dag as a new version
// with N+1, never overwriting history.

import { and, desc, eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import { type ListResult, resolveWindowTotal, totalOverWindow } from "../db/list-result.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import { emitWorkflowLifecycle, getWorkflow, type WorkflowView } from "./service.ts";
import { applyTriggerBindings } from "./trigger-bindings.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";
import { lockWorkflowForVersionWrite } from "./version-write-lock.ts";

export interface VersionView {
  id: string;
  workflow_id: string;
  version: number;
  /** The stored definition, unchanged — not re-parsed against today's schema. */
  dag: unknown;
  /** True when the stored definition no longer passes the current schema.
   *  Such a version can be read but not restored. */
  legacy: boolean;
  note: string | null;
  created_at: Date;
}

export interface ListWorkflowVersionsOptions {
  limit?: number;
  offset?: number;
}

export const WORKFLOW_VERSION_LIST_MAX_LIMIT = 1000;

/** Versions of one workflow, newest first — the first page is the recent
 *  history, which is what a reader looking for the last good version wants.
 *  Without a `limit` the whole history (up to the cap) is returned, so a
 *  caller that does not page sees every version rather than a truncated one. */
export async function listWorkflowVersions(
  tenant_id: string,
  id: string,
  opts: ListWorkflowVersionsOptions = {},
  exec?: Executor,
): Promise<ListResult<VersionView>> {
  const db = exec ?? getDb();
  const limit = Math.min(
    opts.limit ?? WORKFLOW_VERSION_LIST_MAX_LIMIT,
    WORKFLOW_VERSION_LIST_MAX_LIMIT,
  );
  const offset = opts.offset ?? 0;
  const rows = await db
    .select({ row: workflowVersions, total: totalOverWindow() })
    .from(workflowVersions)
    .where(and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.workflow_id, id)))
    .orderBy(desc(workflowVersions.version))
    .limit(limit)
    .offset(offset);
  const total = await resolveWindowTotal(rows, offset, async () => {
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(workflowVersions)
      .where(and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.workflow_id, id)));
    return Number(row?.c ?? 0);
  });
  return {
    rows: rows.map(({ row: r }) => ({
      id: r.id,
      workflow_id: r.workflow_id,
      version: r.version,
      dag: r.dag,
      legacy: !WorkflowDefSchema.safeParse(r.dag).success,
      note: r.note,
      created_at: r.created_at,
    })),
    total,
  };
}

export interface VersionIssue {
  /** Dotted path into the stored definition, e.g. `steps.0.language`. */
  path: string;
  /** Id of the step the path points into, when it points into one. */
  step_id: string | null;
  message: string;
}

/** A stored version whose definition no longer passes the current schema. */
export class VersionNotRestorableError extends Error {
  readonly code = "version_not_restorable";
  readonly version: number;
  readonly issues: VersionIssue[];

  constructor(version: number, issues: VersionIssue[]) {
    const first = issues[0];
    const where = first
      ? `${first.step_id ? `step "${first.step_id}", ` : ""}${first.path || "definition"}: ${first.message}`
      : "the stored definition is not a valid workflow";
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
    super(
      `version ${version} no longer validates against the current workflow definition format — ${where}${more}`,
    );
    this.name = "VersionNotRestorableError";
    this.version = version;
    this.issues = issues;
  }
}

function stepIdAt(dag: unknown, path: ReadonlyArray<PropertyKey>): string | null {
  const index = path[1];
  if (path[0] !== "steps" || typeof index !== "number") return null;
  const steps = (dag as { steps?: unknown } | null)?.steps;
  const step: unknown = Array.isArray(steps) ? steps[index] : undefined;
  const id = (step as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? id : null;
}

/** The stored dag as a current definition, or a `VersionNotRestorableError`
 *  naming the step and field that no longer validate. */
function parseRestorableVersion(version: number, dag: unknown): WorkflowDef {
  const parsed = WorkflowDefSchema.safeParse(dag);
  if (parsed.success) return parsed.data;
  throw new VersionNotRestorableError(
    version,
    parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      step_id: stepIdAt(dag, issue.path),
      message: issue.message,
    })),
  );
}

export async function restoreWorkflowVersion(
  tenant_id: string,
  id: string,
  version: number,
  actor_id: string | null,
  exec?: Executor,
): Promise<WorkflowView | null> {
  const db = exec ?? getDb();
  const updatedId = await db.transaction(async (tx) => {
    if (!(await lockWorkflowForVersionWrite(tx, tenant_id, id))) return null;
    const targetRows = await tx
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, tenant_id),
          eq(workflowVersions.workflow_id, id),
          eq(workflowVersions.version, version),
        ),
      )
      .limit(1);
    const target = targetRows[0];
    if (!target) return null;
    // Restore makes a stored dag the live definition, so it is held to the
    // current schema — and before anything is written, so a refused version
    // leaves no version row, audit entry or lifecycle event behind.
    const restoredDef = parseRestorableVersion(version, target.dag);
    const restoreRows = (await tx
      .select({
        max_version: sql<number>`coalesce(max(${workflowVersions.version}), 0)`,
      })
      .from(workflowVersions)
      .where(
        and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.workflow_id, id)),
      )) as Array<{ max_version: number }>;
    const next = (restoreRows[0]?.max_version ?? 0) + 1;
    const [v] = await tx
      .insert(workflowVersions)
      .values({
        tenant_id,
        workflow_id: id,
        version: next,
        dag: target.dag,
        note: `restored from v${version}`,
      })
      .returning();
    assertInsertRow(v, "restore");
    // Restore makes the target version current, so the top-level description
    // column must track that version's DAG description (mirrors the
    // create/update full-def paths). dag is jsonb-typed `unknown`; read its
    // description defensively.
    const restoredDescription =
      target.dag && typeof target.dag === "object" && !Array.isArray(target.dag)
        ? ((target.dag as { description?: unknown }).description ?? null)
        : null;
    await tx
      .update(workflows)
      .set({
        current_version_id: v.id,
        description: typeof restoredDescription === "string" ? restoredDescription : null,
        updated_at: new Date(),
      })
      .where(eq(workflows.id, id));
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.WORKFLOW_VERSION_RESTORED,
        resource_type: "workflow",
        resource_id: id,
        result: "success",
        metadata: { restored_from: version, new_version: next },
      },
      tx,
    );
    // A version restore replaces what `readResource("workflow://<id>")`
    // returns; MCP subscribers must be notified.
    await emitWorkflowLifecycle(tx, {
      tenant_id,
      type: "workflow.version_restored",
      payload: {
        workflow_id: id,
        restored_from: version,
        new_version: next,
        actor_id: actor_id ?? null,
      },
    });
    log.workflow.restored({
      workflow_id: id,
      tenant_id,
      restored_from: version,
      new_version: next,
      actor_id,
    });
    // Re-apply trigger bindings from the restored definition. A
    // workflow that was, for example, scheduled at v3 but rotated to a
    // request-only v4 must have its schedule torn down on restore-to-
    // v3 and re-bound; otherwise the public surface drifts from the
    // committed dag.
    const wfRows = await tx
      .select({ slug: workflows.slug })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id)))
      .limit(1);
    const wfSlug = wfRows[0]?.slug ?? id;
    await applyTriggerBindings(tx, tenant_id, id, wfSlug, restoredDef, actor_id);
    return id;
  });
  if (!updatedId) return null;
  return getWorkflow(tenant_id, updatedId, db);
}
