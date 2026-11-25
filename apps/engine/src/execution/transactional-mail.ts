import { z } from "@hono/zod-openapi";
import { and, desc, eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Executor } from "../db/client.ts";
import { withTenantScope } from "../db/index.ts";
import { transactionalMailReceipts, webhooksInbound } from "../db/schema/index.ts";
import type { TransactionalDeliveryBoundary } from "../workflows/transactional-delivery-boundary.ts";
import type { StepResult } from "./types.ts";

export async function transactionalWebhookAvailable(
  db: Executor,
  tenant: string,
  workflow: string,
  boundary: TransactionalDeliveryBoundary,
) {
  const [hook] = await withTenantScope(db, tenant, (tx) =>
    tx
      .select({
        verifier: webhooksInbound.verifier,
        config: webhooksInbound.native_verifier_config,
      })
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, tenant),
          eq(webhooksInbound.id, boundary.webhook_id),
          eq(webhooksInbound.workflow_id, workflow),
          eq(webhooksInbound.active, true),
        ),
      )
      .limit(1),
  );
  const config = hook?.config as { skip?: unknown; events?: unknown; hmac?: unknown } | null;
  if (
    !hook ||
    config?.skip === true ||
    !Array.isArray(config?.events) ||
    config.events.length !== 1 ||
    config.events[0] !== boundary.event_type
  )
    return false;
  if (boundary.webhook_verifier === "stripe")
    return (
      hook.verifier === "stripe" &&
      boundary.request_id_input === "body.id" &&
      boundary.event_type_input === "body.type"
    );
  if (boundary.webhook_verifier !== "hmac") return hook.verifier === "standard";
  if (hook.verifier !== "hmac") return false;
  const { HmacVerifierConfig } = await import("../webhooks/index.ts");
  const parsed = HmacVerifierConfig.safeParse(config.hmac);
  if (!parsed.success) return false;
  const hmac = parsed.data;
  return (
    hmac.signed_payload === "v1:{timestamp}:{body}" &&
    Boolean(hmac.timestamp_header) &&
    hmac.tolerance_seconds <= 300 &&
    Boolean(hmac.id_field) &&
    Boolean(hmac.type_field) &&
    !hmac.type_header &&
    boundary.request_id_input === `body.${hmac.id_field}` &&
    boundary.event_type_input === `body.${hmac.type_field}`
  );
}

export async function reserveTransactionalMail(
  db: Executor,
  input: {
    tenant_id: string;
    workflow_id: string;
    request_id: string;
    execution_id: string;
    step_id: string;
  },
  request_source: "webhook" | "scheduler" = "webhook",
) {
  await db.transaction(async (tx) => {
    const [receipt] = await tx
      .insert(transactionalMailReceipts)
      .values({ ...input, state: "attempted" })
      .onConflictDoNothing()
      .returning();
    if (!receipt)
      throw Object.assign(
        new Error(
          "This request already has a mail dispatch attempt; inspect its receipt before any resend",
        ),
        { code: "execution_boundary_mismatch", reason: "transactional_mail_already_attempted" },
      );
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        action: AuditAction.TRANSACTIONAL_MAIL_RESERVED,
        resource_type: "execution",
        resource_id: input.execution_id,
        actor_type: "system",
        result: "success",
        metadata: {
          request_source,
          step_id: input.step_id,
          request_id: input.request_id,
        },
      },
      tx,
    );
  });
}

export async function mailsReservedWithinDay(
  db: Executor,
  tenantId: string,
  workflowId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactionalMailReceipts)
    .where(
      and(
        eq(transactionalMailReceipts.tenant_id, tenantId),
        eq(transactionalMailReceipts.workflow_id, workflowId),
        sql`${transactionalMailReceipts.created_at} > clock_timestamp() - interval '24 hours'`,
      ),
    );
  return row?.count ?? 0;
}

export function isConfirmedTransactionalMail(
  result: Pick<StepResult, "status" | "output" | "request_meta">,
): boolean {
  const output = result.output as { id?: unknown } | null | undefined;
  const status =
    result.request_meta && "status" in result.request_meta ? result.request_meta.status : undefined;
  return (
    result.status === "succeeded" &&
    typeof status === "number" &&
    status >= 200 &&
    status < 300 &&
    typeof output?.id === "string" &&
    output.id.length > 0
  );
}

export async function settleTransactionalMail(
  db: Executor,
  input: {
    tenant_id: string;
    execution_id: string;
    step_id: string;
  },
  result: Pick<StepResult, "status" | "output" | "request_meta">,
) {
  const state = isConfirmedTransactionalMail(result) ? "sent" : "delivery_unknown";
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(transactionalMailReceipts)
      .set({ state, updated_at: sql`clock_timestamp()` })
      .where(
        and(
          eq(transactionalMailReceipts.tenant_id, input.tenant_id),
          eq(transactionalMailReceipts.execution_id, input.execution_id),
          eq(transactionalMailReceipts.step_id, input.step_id),
          eq(transactionalMailReceipts.state, "attempted"),
        ),
      )
      .returning();
    if (!updated.length) return;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        action: AuditAction.TRANSACTIONAL_MAIL_SETTLED,
        resource_type: "execution",
        resource_id: input.execution_id,
        actor_type: "system",
        result: state === "sent" ? "success" : "error",
        metadata: { request_source: "webhook", step_id: input.step_id, state },
      },
      tx,
    );
  });
}

export const TransactionalMailReceiptSchema = z
  .object({
    request_id: z.string().uuid(),
    execution_id: z.string().uuid(),
    step_id: z.string(),
    state: z.enum(["attempted", "sent", "failed", "delivery_unknown"]),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("TransactionalMailReceipt");

export async function listTransactionalMailReceipts(
  db: Executor,
  tenantId: string,
  workflowId: string,
  limit = 20,
  offset = 0,
) {
  const rows = await db
    .select()
    .from(transactionalMailReceipts)
    .where(
      and(
        eq(transactionalMailReceipts.tenant_id, tenantId),
        eq(transactionalMailReceipts.workflow_id, workflowId),
      ),
    )
    .orderBy(desc(transactionalMailReceipts.created_at), transactionalMailReceipts.request_id)
    .limit(limit)
    .offset(offset);
  return rows.map(({ request_id, execution_id, step_id, state, created_at, updated_at }) => ({
    request_id,
    execution_id,
    step_id,
    state,
    created_at: created_at.toISOString(),
    updated_at: updated_at.toISOString(),
  }));
}
