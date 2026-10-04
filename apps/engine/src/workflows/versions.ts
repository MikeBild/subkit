import { and, desc, eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import { type ListResult, resolveWindowTotal, totalOverWindow } from "../db/list-result.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import { carryApprovalsForward } from "./authority-inheritance.ts";
import { emitWorkflowLifecycle, getWorkflow, type WorkflowView } from "./service.ts";
import {
  describeVersionIssues,
  readStoredDefinition,
  type VersionIssue,
} from "./stored-definition.ts";
import { applyTriggerBindings } from "./trigger-bindings.ts";
import type { WorkflowDef } from "./types.ts";
import { lockWorkflowForVersionWrite } from "./version-write-lock.ts";

export interface VersionView {
  id: string;
  workflow_id: string;
  version: number;
  dag: unknown;
  invalid: boolean;
  note: string | null;
  created_at: Date;
}

export interface ListWorkflowVersionsOptions {
  limit?: number;
  offset?: number;
}

export const WORKFLOW_VERSION_LIST_MAX_LIMIT = 200;
export const WORKFLOW_VERSION_LIST_DEFAULT_LIMIT = 50;

export async function listWorkflowVersions(
  tenant_id: string,
  id: string,
  opts: ListWorkflowVersionsOptions = {},
  exec?: Executor,
): Promise<ListResult<VersionView>> {
  const db = exec ?? getDb();
  const limit = Math.min(
    opts.limit ?? WORKFLOW_VERSION_LIST_DEFAULT_LIMIT,
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
      invalid: readStoredDefinition(r.dag).invalid,
      note: r.note,
      created_at: r.created_at,
    })),
    total,
  };
}

export class VersionNotRestorableError extends Error {
  readonly code = "version_not_restorable";
  readonly version: number;
  readonly issues: VersionIssue[];

  constructor(version: number, issues: VersionIssue[]) {
    super(
      `version ${version} no longer validates against the current workflow definition format — ${describeVersionIssues(issues)}`,
    );
    this.name = "VersionNotRestorableError";
    this.version = version;
    this.issues = issues;
  }
}

function parseRestorableVersion(version: number, dag: unknown): WorkflowDef {
  const stored = readStoredDefinition(dag);
  if (stored.invalid) throw new VersionNotRestorableError(version, stored.issues);
  return stored.definition;
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
    const locked = await lockWorkflowForVersionWrite(tx, tenant_id, id);
    if (!locked) return null;
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
    await carryApprovalsForward(tx, {
      tenant_id,
      workflow_id: id,
      from_version_id: locked.current_version_id,
      to_version_id: v.id,
      actor_id,
    });
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
