import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import { AuditAction, type AuditActionValue, auditAwait } from "../../../audit/index.ts";
import type { Executor, ScopedTx } from "../../../db/index.ts";
import {
  type VaultPaymentStatus,
  vaultItems,
  vaultPayments,
  vaultSecretTickets,
  withTenantScope,
} from "../../../db/index.ts";
import { VaultError } from "../../persistence/store.ts";
import { decryptVaultItemValue } from "../../persistence/use.ts";
import {
  PAYMENT_APPROVAL_TTL_MS,
  type PaymentRefusal,
  paymentDecisionRefusal,
  paymentStep,
  payTicketValues,
} from "../core/rules.ts";
import { startVaultUse } from "./tickets.ts";

export interface VaultPaymentView {
  readonly id: string;
  readonly status: VaultPaymentStatus;
  readonly origin: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly card: { readonly brand: string; readonly last4: string };
  readonly expires_at: string;
  readonly created_at: string;
  readonly conversation_id: string | null;
  readonly task_run_id: string | null;
}

type PaymentRow = typeof vaultPayments.$inferSelect;

export function paymentView(row: PaymentRow): VaultPaymentView {
  return {
    id: row.id,
    status: row.status,
    origin: row.origin,
    amount_minor: row.amount_minor,
    currency: row.currency,
    card: { brand: row.card_brand, last4: row.card_last4 },
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
    conversation_id: row.conversation_id,
    task_run_id: row.task_run_id,
  };
}

async function auditPayment(
  tx: Executor,
  row: PaymentRow,
  action: AuditActionValue,
  actor_id: string | null,
): Promise<void> {
  await auditAwait(
    {
      tenant_id: row.tenant_id,
      actor_type: actor_id ? "user" : "system",
      actor_id,
      action,
      resource_type: "vault_payment",
      resource_id: row.id,
      result: "success",
      metadata: {
        card_item_id: row.card_item_id,
        origin: row.origin,
        amount_minor: row.amount_minor,
        currency: row.currency,
        card_brand: row.card_brand,
        card_last4: row.card_last4,
        ...(row.conversation_id ? { conversation_id: row.conversation_id } : {}),
        ...(row.task_run_id ? { task_run_id: row.task_run_id } : {}),
        ...(row.execution_id ? { execution_id: row.execution_id } : {}),
      },
    },
    tx,
  );
}

export interface PaymentRequest {
  readonly tenant_id: string;
  readonly owner_user_id: string;
  readonly card_item_id: string;
  readonly card_value_digest: string;
  readonly card_brand: string;
  readonly card_last4: string;
  readonly origin: string;
  readonly page_fingerprint: string;
  readonly fields: Record<string, string>;
  readonly field_frames: Record<string, string>;
  readonly submit_ref: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly device_id: string;
  readonly command_id: string;
  readonly conversation_id: string | null;
  readonly tool_call_id: string | null;
  readonly task_run_id: string | null;
  readonly execution_id: string | null;
}

export async function requestVaultPayment(
  db: Executor,
  request: PaymentRequest,
  now: Date,
): Promise<VaultPaymentView> {
  return await withTenantScope(db, request.tenant_id, async (tx) => {
    const [row] = await tx
      .insert(vaultPayments)
      .values({
        ...request,
        status: "pending",
        expires_at: new Date(now.getTime() + PAYMENT_APPROVAL_TTL_MS),
      })
      .returning();
    if (!row) throw new Error("vault payment insert returned no row");
    await auditPayment(tx, row, AuditAction.VAULT_PAYMENT_REQUESTED, request.owner_user_id);
    return paymentView(row);
  });
}

export async function listVaultPayments(
  db: Executor,
  p: {
    readonly tenant_id: string;
    readonly owner_user_id: string;
    readonly status?: VaultPaymentStatus | undefined;
  },
  now: Date,
): Promise<VaultPaymentView[]> {
  await expireVaultPayments(db, p.tenant_id, now);
  const rows = await withTenantScope(db, p.tenant_id, (tx) =>
    tx
      .select()
      .from(vaultPayments)
      .where(
        and(
          eq(vaultPayments.tenant_id, p.tenant_id),
          eq(vaultPayments.owner_user_id, p.owner_user_id),
          p.status ? eq(vaultPayments.status, p.status) : undefined,
        ),
      )
      .orderBy(desc(vaultPayments.created_at))
      .limit(100),
  );
  return rows.map(paymentView);
}

export async function pendingVaultPayments(
  db: Executor,
  tenant_id: string,
  owner_user_id: string,
  now: Date,
): Promise<VaultPaymentView[]> {
  const rows = await withTenantScope(db, tenant_id, (tx) =>
    tx
      .select()
      .from(vaultPayments)
      .where(
        and(
          eq(vaultPayments.tenant_id, tenant_id),
          eq(vaultPayments.owner_user_id, owner_user_id),
          eq(vaultPayments.status, "pending"),
          gt(vaultPayments.expires_at, now),
        ),
      )
      .orderBy(desc(vaultPayments.created_at))
      .limit(20),
  );
  return rows.map(paymentView);
}

export async function expireVaultPayments(
  db: Executor,
  tenant_id: string,
  now: Date,
): Promise<number> {
  const step = paymentStep("expire");
  return await withTenantScope(db, tenant_id, async (tx) => {
    const rows = await tx
      .update(vaultPayments)
      .set({ status: step.to, updated_at: now })
      .where(
        and(
          eq(vaultPayments.tenant_id, tenant_id),
          eq(vaultPayments.status, step.from),
          lte(vaultPayments.expires_at, now),
        ),
      )
      .returning();
    for (const row of rows) await auditPayment(tx, row, AuditAction.VAULT_PAYMENT_EXPIRED, null);
    return rows.length;
  });
}

export type PaymentDecision =
  | { readonly ok: true; readonly payment: VaultPaymentView; readonly tool_call_id: string | null }
  | { readonly ok: false; readonly code: PaymentRefusal | "payment_not_found" | "card_changed" };

async function lockedPayment(tx: ScopedTx, tenant_id: string, id: string) {
  const [row] = await tx
    .select()
    .from(vaultPayments)
    .where(and(eq(vaultPayments.tenant_id, tenant_id), eq(vaultPayments.id, id)))
    .for("update")
    .limit(1);
  return row ?? null;
}

export async function approveVaultPayment(
  db: Executor,
  p: {
    readonly tenant_id: string;
    readonly id: string;
    readonly actor_id: string;
    readonly cvv: string;
  },
  now: Date,
): Promise<PaymentDecision> {
  await expireVaultPayments(db, p.tenant_id, now);
  return await withTenantScope(db, p.tenant_id, async (tx) => {
    const row = await lockedPayment(tx, p.tenant_id, p.id);
    if (!row) return { ok: false, code: "payment_not_found" } as const;
    const refusal = paymentDecisionRefusal(row, p.actor_id, now);
    if (refusal !== null) return { ok: false, code: refusal } as const;
    const [card] = await tx
      .select({ id: vaultItems.id })
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.tenant_id, p.tenant_id),
          eq(vaultItems.id, row.card_item_id),
          eq(vaultItems.owner_user_id, p.actor_id),
          eq(vaultItems.kind, "card"),
          isNull(vaultItems.deleted_at),
        ),
      )
      .limit(1);
    if (!card) return { ok: false, code: "card_changed" } as const;
    let value: Awaited<ReturnType<typeof decryptVaultItemValue>>;
    try {
      value = await decryptVaultItemValue(tx, {
        tenant_id: p.tenant_id,
        item_id: row.card_item_id,
        value_digest: row.card_value_digest,
      });
    } catch (error) {
      if (error instanceof VaultError) return { ok: false, code: "card_changed" } as const;
      throw error;
    }
    if (value.kind !== "card") return { ok: false, code: "card_changed" } as const;
    const started = await startVaultUse(
      tx,
      {
        tenant_id: p.tenant_id,
        item_id: row.card_item_id,
        actor_id: p.actor_id,
        purpose: "pay",
        origin: row.origin,
        conversation_id: row.conversation_id,
        run_id: row.task_run_id ?? row.execution_id,
        task_id: null,
        device_id: row.device_id,
        command_id: row.command_id,
      },
      payTicketValues(value, p.cvv),
      now,
    );
    if (!started.ok) return { ok: false, code: "payment_not_pending" } as const;
    const step = paymentStep("approve");
    const [approved] = await tx
      .update(vaultPayments)
      .set({ status: step.to, approved_at: now, use_id: started.use_id, updated_at: now })
      .where(and(eq(vaultPayments.id, row.id), eq(vaultPayments.status, step.from)))
      .returning();
    if (!approved) return { ok: false, code: "payment_not_pending" } as const;
    await auditPayment(tx, approved, AuditAction.VAULT_PAYMENT_APPROVED, p.actor_id);
    return {
      ok: true,
      payment: paymentView(approved),
      tool_call_id: approved.tool_call_id,
    } as const;
  });
}

export async function rejectVaultPayment(
  db: Executor,
  p: { readonly tenant_id: string; readonly id: string; readonly actor_id: string },
  now: Date,
): Promise<PaymentDecision> {
  await expireVaultPayments(db, p.tenant_id, now);
  return await withTenantScope(db, p.tenant_id, async (tx) => {
    const row = await lockedPayment(tx, p.tenant_id, p.id);
    if (!row) return { ok: false, code: "payment_not_found" } as const;
    const refusal = paymentDecisionRefusal(row, p.actor_id, now);
    if (refusal !== null) return { ok: false, code: refusal } as const;
    const step = paymentStep("reject");
    const [rejected] = await tx
      .update(vaultPayments)
      .set({ status: step.to, updated_at: now })
      .where(and(eq(vaultPayments.id, row.id), eq(vaultPayments.status, step.from)))
      .returning();
    if (!rejected) return { ok: false, code: "payment_not_pending" } as const;
    await auditPayment(tx, rejected, AuditAction.VAULT_PAYMENT_REJECTED, p.actor_id);
    return {
      ok: true,
      payment: paymentView(rejected),
      tool_call_id: rejected.tool_call_id,
    } as const;
  });
}

export type ConsumedPayment =
  | {
      readonly ok: true;
      readonly use_id: string;
      readonly ticket_id: string;
      readonly page_fingerprint: string;
      readonly field_frames: Record<string, string>;
    }
  | { readonly ok: false; readonly code: "payment_not_approved" };

export async function consumeApprovedPayment(
  db: Executor,
  p: { readonly tenant_id: string; readonly command_id: string },
  now: Date,
): Promise<ConsumedPayment> {
  const step = paymentStep("consume");
  return await withTenantScope(db, p.tenant_id, async (tx) => {
    const [consumed] = await tx
      .update(vaultPayments)
      .set({ status: step.to, updated_at: now })
      .where(
        and(
          eq(vaultPayments.tenant_id, p.tenant_id),
          eq(vaultPayments.command_id, p.command_id),
          eq(vaultPayments.status, step.from),
        ),
      )
      .returning();
    if (!consumed?.use_id) return { ok: false, code: "payment_not_approved" } as const;
    const [ticket] = await tx
      .select({ id: vaultSecretTickets.id })
      .from(vaultSecretTickets)
      .where(
        and(
          eq(vaultSecretTickets.tenant_id, p.tenant_id),
          eq(vaultSecretTickets.use_id, consumed.use_id),
        ),
      )
      .limit(1);
    if (!ticket) return { ok: false, code: "payment_not_approved" } as const;
    return {
      ok: true,
      use_id: consumed.use_id,
      ticket_id: ticket.id,
      page_fingerprint: consumed.page_fingerprint,
      field_frames: consumed.field_frames,
    } as const;
  });
}

export async function rejectPendingPaymentOf(
  db: Executor,
  p: { readonly tenant_id: string; readonly command_id: string },
  now: Date,
): Promise<void> {
  const step = paymentStep("reject");
  await withTenantScope(db, p.tenant_id, async (tx) => {
    const rows = await tx
      .update(vaultPayments)
      .set({ status: step.to, updated_at: now })
      .where(
        and(
          eq(vaultPayments.tenant_id, p.tenant_id),
          eq(vaultPayments.command_id, p.command_id),
          eq(vaultPayments.status, step.from),
        ),
      )
      .returning();
    for (const row of rows) await auditPayment(tx, row, AuditAction.VAULT_PAYMENT_REJECTED, null);
  });
}

export async function paymentStatusOf(
  db: Executor,
  tenant_id: string,
  id: string,
): Promise<VaultPaymentStatus | null> {
  const [row] = await withTenantScope(db, tenant_id, (tx) =>
    tx
      .select({ status: vaultPayments.status })
      .from(vaultPayments)
      .where(and(eq(vaultPayments.tenant_id, tenant_id), eq(vaultPayments.id, id)))
      .limit(1),
  );
  return row?.status ?? null;
}
