import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Executor } from "../db/client.ts";
import { executions } from "../db/schema/index.ts";
import type { Decision } from "../rbac/index.ts";
import type { CallerContext } from "./caller-context.ts";

export const WorkflowPermissionSchema = z
  .object({
    permission: z.literal("workflow:run"),
    phase: z.enum(["admission", "start"]),
    workflow_id: z.uuid(),
    tenant_id: z.uuid(),
    principal_id: z.string().min(1),
    principal_kind: z.enum(["user", "system_account"]),
    source: z.enum(["builtin_admin", "resource_grant", "group", "role", "portal_token_allowlist"]),
    checked_at: z.iso.datetime(),
  })
  .strict();

export type WorkflowPermission = z.infer<typeof WorkflowPermissionSchema>;

export async function captureWorkflowPermission(
  db: Executor,
  principal: ResolvedPrincipal,
  workflow_id: string,
  decision: Decision,
  phase: "admission" | "start" = "admission",
): Promise<WorkflowPermission | null> {
  if (
    !decision.allow ||
    !decision.source ||
    decision.source === "credential_ceiling" ||
    decision.source === "operator_boundary"
  )
    return null;
  const clock = await db.execute<{ checked_at: Date }>(sql`SELECT clock_timestamp() AS checked_at`);
  const at = clock.rows[0]?.checked_at;
  if (!at) return null;
  return WorkflowPermissionSchema.parse({
    permission: "workflow:run",
    phase,
    workflow_id,
    tenant_id: principal.tenant_id,
    principal_id: principal.id,
    principal_kind: principal.kind,
    source: decision.source,
    checked_at: new Date(at).toISOString(),
  });
}

export function matchingWorkflowPermission(
  value: unknown,
  caller: CallerContext | null | undefined,
  workflow_id: string | null | undefined,
): WorkflowPermission | null {
  const parsed = WorkflowPermissionSchema.safeParse(value);
  if (
    !parsed.success ||
    !caller ||
    parsed.data.workflow_id !== workflow_id ||
    parsed.data.tenant_id !== caller.tenantId ||
    parsed.data.principal_id !== caller.principalId ||
    parsed.data.principal_kind !== caller.principalKind
  )
    return null;
  return parsed.data;
}

export async function recordStartingWorkflowPermission(
  db: Executor,
  execution_id: string,
  caller: CallerContext,
  proof: WorkflowPermission | null,
): Promise<void> {
  if (proof?.phase !== "start" || !matchingWorkflowPermission(proof, caller, proof.workflow_id))
    return;
  await db
    .update(executions)
    .set({
      authorization_context: sql`jsonb_set(${executions.authorization_context}, '{workflow_permission}', ${JSON.stringify(proof)}::jsonb)`,
    })
    .where(
      and(
        eq(executions.tenant_id, caller.tenantId),
        eq(executions.id, execution_id),
        eq(executions.workflow_id, proof.workflow_id),
        eq(executions.status, "queued"),
        isNull(executions.started_at),
        sql`${executions.caller_context} = ${JSON.stringify(caller)}::jsonb`,
        sql`${executions.authorization_context} IS NOT NULL`,
        sql`NOT (${executions.authorization_context} ? 'workflow_permission')`,
      ),
    );
}
