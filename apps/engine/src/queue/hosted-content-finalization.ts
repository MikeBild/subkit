import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { AuditAction, auditAwait } from "../audit/index.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Executor } from "../db/client.ts";
import {
  HOSTED_CONTENT_QUOTA_MESSAGE,
  type HostedContentQuotaCode,
  hostedControlReceiptId,
} from "../db/hosted-control-receipt.ts";
import {
  HostedResourceCountError,
  HostedStorageQuotaError,
  hostedQuotaError,
} from "../db/hosted-quota-errors.ts";
import { executions, mcpTasks, tenants } from "../db/schema/index.ts";
import { settleExecutionGuards } from "../execution/index.ts";
import { withContext } from "../logging/context.ts";
import { now } from "../utils/clock.ts";

export function hostedContentQuotaCode(error: unknown): HostedContentQuotaCode | null {
  const quota = hostedQuotaError(error);
  if (quota instanceof HostedStorageQuotaError || quota instanceof HostedResourceCountError)
    return quota.code;
  return null;
}

export async function finalizeHostedContentQuota(
  db: Executor,
  args: {
    tenantId: string;
    resourceId: string;
    code: HostedContentQuotaCode;
  } & ({ resourceType: "execution" } | { resourceType: "mcp_task"; expectedJobId: string }),
): Promise<"unmatched" | "stale" | "finalized"> {
  z.uuid().parse(args.tenantId);
  z.uuid().parse(args.resourceId);
  z.enum(["hosted_storage_quota_exhausted", "hosted_resource_count_exhausted"]).parse(args.code);
  return db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, args.tenantId);
    const [tenant] = await tx
      .select({ origin: tenants.origin })
      .from(tenants)
      .where(eq(tenants.id, args.tenantId))
      .for("share")
      .limit(1);
    if (tenant?.origin !== "self_service") return "unmatched";
    if (args.resourceType === "execution") {
      const [row] = await tx
        .select({ status: executions.status })
        .from(executions)
        .where(and(eq(executions.tenant_id, args.tenantId), eq(executions.id, args.resourceId)))
        .for("update")
        .limit(1);
      if (!row || !["queued", "running"].includes(row.status)) return "stale";
      await tx
        .update(executions)
        .set({
          status: "failed",
          finished_at: new Date(now()),
          failure: {
            step_id: null,
            error_code: args.code,
            error_message: HOSTED_CONTENT_QUOTA_MESSAGE,
          },
        })
        .where(
          and(
            eq(executions.tenant_id, args.tenantId),
            eq(executions.id, args.resourceId),
            inArray(executions.status, ["queued", "running"]),
          ),
        );
      await settleExecutionGuards(tx, {
        tenant_id: args.tenantId,
        execution_id: args.resourceId,
        status: "failed",
        output: null,
      });
    } else {
      const [row] = await tx
        .select()
        .from(mcpTasks)
        .where(and(eq(mcpTasks.tenant_id, args.tenantId), eq(mcpTasks.id, args.resourceId)))
        .for("update")
        .limit(1);
      if (
        !row ||
        row.result ||
        row.failure_reason ||
        row.cancelled_at ||
        row.job_id !== args.expectedJobId
      )
        return "stale";
      await tx
        .update(mcpTasks)
        .set({ failure_reason: args.code, updated_at: new Date(now()) })
        .where(
          and(
            eq(mcpTasks.tenant_id, args.tenantId),
            eq(mcpTasks.id, args.resourceId),
            isNull(mcpTasks.failure_reason),
            isNull(mcpTasks.result),
            isNull(mcpTasks.cancelled_at),
          ),
        );
    }
    await withContext({ execution_privacy: undefined, auth_via: undefined }, () =>
      auditAwait(
        {
          id: hostedControlReceiptId(args.tenantId, args.resourceType, args.resourceId),
          tenant_id: args.tenantId,
          actor_type: "system",
          actor_id: null,
          action:
            args.resourceType === "execution"
              ? AuditAction.EXECUTION_FAILED
              : AuditAction.CONVERSATION_TURN_FAILED,
          resource_type: args.resourceType,
          resource_id: args.resourceId,
          result: "denied",
          reason: args.code,
          metadata: { code: args.code },
          before: null,
          after: null,
          ip: null,
          user_agent: null,
          trace_id: "",
        },
        tx,
      ),
    );
    return "finalized";
  });
}
