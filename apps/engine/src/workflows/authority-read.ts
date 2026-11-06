import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import {
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../db/schema/index.ts";
import { effectChanges } from "./authority-changes.ts";
import { observeWorkflowAuthority } from "./authority-observation.ts";
import { readDatabaseNow } from "./database-clock.ts";
import type { WorkflowEffectManifest } from "./effect-manifest.ts";
import { previewWorkflowAuthority } from "./execution-authorities.ts";

interface ReviewedAuthorityVersion {
  tenant_id: string;
  workflow_id: string;
  workflow_version_id: string;
  execution_environment: "dev" | "prod";
}

export async function reviewEffectChanges(
  db: Executor,
  reviewed: ReviewedAuthorityVersion,
  reference: WorkflowEffectManifest | null,
  manifest: WorkflowEffectManifest,
) {
  const fallback = async () => {
    const [workflow] = await db
      .select({ current: workflows.current_version_id })
      .from(workflows)
      .where(
        and(eq(workflows.tenant_id, reviewed.tenant_id), eq(workflows.id, reviewed.workflow_id)),
      )
      .limit(1);
    if (!workflow?.current || workflow.current === reviewed.workflow_version_id) return null;
    try {
      return (
        await previewWorkflowAuthority({ ...reviewed, workflow_version_id: workflow.current }, db)
      ).manifest;
    } catch {
      return null;
    }
  };
  const base = reference ?? (await fallback());
  if (!base || base.workflow_version_id === reviewed.workflow_version_id) return null;
  const [version] = await db
    .select({ version: workflowVersions.version })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, reviewed.tenant_id),
        eq(workflowVersions.id, base.workflow_version_id),
      ),
    )
    .limit(1);
  return {
    effect_changes: effectChanges(base, manifest),
    ...(version
      ? {
          effect_changes_base: {
            workflow_version_id: base.workflow_version_id,
            version: version.version,
            approved: reference !== null,
          },
        }
      : {}),
  };
}

export async function observeAuthorityById(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  authority_id: string,
) {
  const [row] = await db
    .select()
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, workflow_id),
        eq(workflowExecutionAuthorities.id, authority_id),
      ),
    )
    .limit(1);
  if (!row) return null;
  const [workflow] = await db
    .select({
      lifecycle: workflows.lifecycle,
      current_version_id: workflows.current_version_id,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const now = await readDatabaseNow(db);
  return observeWorkflowAuthority(db, row, workflow, now);
}

type AuthorityPage =
  | { ok: true; ids: string[]; next_cursor: string | null }
  | { ok: false; missing: "workflow" | "authority cursor" };

export async function pageWorkflowAuthorityIds(
  db: Executor,
  scope: {
    tenant_id: string;
    workflow_id: string;
    cursor?: string | undefined;
    environment?: "dev" | "prod" | undefined;
    limit: number;
  },
): Promise<AuthorityPage> {
  const { tenant_id, workflow_id: id, cursor, environment, limit } = scope;
  const [workflow] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id), isNull(workflows.deleted_at)),
    )
    .limit(1);
  if (!workflow) return { ok: false, missing: "workflow" };
  const filter = and(
    eq(workflowExecutionAuthorities.workflow_id, id),
    environment ? eq(workflowExecutionAuthorities.execution_environment, environment) : undefined,
  );
  if (cursor) {
    const [found] = await db
      .select({ id: workflowExecutionAuthorities.id })
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, tenant_id),
          filter,
          eq(workflowExecutionAuthorities.id, cursor),
        ),
      )
      .limit(1);
    if (!found) return { ok: false, missing: "authority cursor" };
  }
  const anchor = db
    .select({
      created_at: workflowExecutionAuthorities.created_at,
      id: workflowExecutionAuthorities.id,
    })
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, tenant_id),
        filter,
        eq(workflowExecutionAuthorities.id, cursor ?? "00000000-0000-0000-0000-000000000000"),
      ),
    );
  const rows = await db
    .select({ id: workflowExecutionAuthorities.id })
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, tenant_id),
        filter,
        cursor
          ? sql`(${workflowExecutionAuthorities.created_at}, ${workflowExecutionAuthorities.id}) < (${anchor})`
          : undefined,
      ),
    )
    .orderBy(desc(workflowExecutionAuthorities.created_at), desc(workflowExecutionAuthorities.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    ok: true,
    ids: page.map((row) => row.id),
    next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export function listEnabledScheduleBasis(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  environment: "dev" | "prod",
) {
  return db
    .select({
      cron: workflowsSchedules.cron,
      timezone: workflowsSchedules.timezone,
      input: workflowsSchedules.input,
      last_enqueued_at: workflowsSchedules.last_enqueued_at,
      created_at: workflowsSchedules.created_at,
    })
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenant_id),
        eq(workflowsSchedules.workflow_id, workflow_id),
        eq(workflowsSchedules.paused, false),
        eq(workflowsSchedules.execution_mode, environment),
      ),
    );
}
