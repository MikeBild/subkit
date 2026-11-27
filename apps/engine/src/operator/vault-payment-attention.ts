import type { ResolvedPrincipal } from "../auth/index.ts";
import type { Db } from "../db/index.ts";
import {
  type PendingSignIn,
  pendingSignIns,
  pendingVaultPayments,
  type VaultPaymentView,
} from "../vault/index.ts";
import { type AttentionItem, compareAttentionItems } from "./core/attention.ts";

export const VAULT_PAYMENT_ATTENTION_KIND = "vault_payment_pending";
export const VAULT_SIGN_IN_ATTENTION_KIND = "vault_sign_in_pending";
const OWNER_PERMISSION = "conversation:write";

export function paymentApprovalHref(payment: VaultPaymentView): string {
  return payment.conversation_id
    ? `/cockpit/chat/${encodeURIComponent(payment.conversation_id)}?payment=${encodeURIComponent(payment.id)}`
    : `/cockpit/vault?payment=${encodeURIComponent(payment.id)}`;
}

export function paymentAttentionItem(payment: VaultPaymentView): AttentionItem {
  return {
    id: `vault_payment:${payment.id}`,
    class: "decide",
    severity: "urgent",
    kind: VAULT_PAYMENT_ATTENTION_KIND,
    subject: payment.conversation_id
      ? { kind: "conversation", id: payment.conversation_id, name: payment.origin }
      : null,
    reason: "payment_approval_needed",
    trigger: null,
    cause_class: null,
    counts: {},
    since: payment.created_at,
    deadline: payment.expires_at,
    detail: null,
    vault: {
      kind: "payment",
      id: payment.id,
      origin: payment.origin,
      conversation_id: payment.conversation_id,
      amount_minor: payment.amount_minor,
      currency: payment.currency,
      card: payment.card,
    },
    actions: [
      {
        verb: "review",
        href: paymentApprovalHref(payment),
        primary: true,
        permission: OWNER_PERMISSION,
      },
    ],
  };
}

export function signInAttentionItem(sign_in: PendingSignIn): AttentionItem {
  return {
    id: `vault_sign_in:${sign_in.tool_call_id}`,
    class: "decide",
    severity: "urgent",
    kind: VAULT_SIGN_IN_ATTENTION_KIND,
    subject: { kind: "conversation", id: sign_in.conversation_id, name: sign_in.origin },
    reason: "sign_in_confirmation_needed",
    trigger: null,
    cause_class: null,
    counts: {},
    since: sign_in.since.toISOString(),
    deadline: sign_in.deadline,
    detail: null,
    vault: {
      kind: "sign_in",
      id: sign_in.tool_call_id,
      origin: sign_in.origin,
      conversation_id: sign_in.conversation_id,
    },
    actions: [
      {
        verb: "answer",
        href: `/cockpit/chat/${encodeURIComponent(sign_in.conversation_id)}`,
        primary: true,
        permission: OWNER_PERMISSION,
      },
    ],
  };
}

export async function withVaultPaymentAttention(
  db: Db,
  principal: ResolvedPrincipal,
  items: readonly AttentionItem[],
  now: Date,
): Promise<AttentionItem[]> {
  if (principal.kind !== "user") return [...items];
  const [payments, signIns] = await Promise.all([
    pendingVaultPayments(db, principal.tenant_id, principal.id, now),
    pendingSignIns(db, principal.tenant_id, principal.id, now),
  ]);
  if (payments.length === 0 && signIns.length === 0) return [...items];
  const replaced = new Set([
    ...payments.flatMap((payment) =>
      payment.conversation_id ? [`conversation:${payment.conversation_id}`] : [],
    ),
    ...signIns.map((sign_in) => `conversation:${sign_in.conversation_id}`),
  ]);
  const others = items.filter(
    (item) => !(item.reason === "local_confirmation_needed" && replaced.has(item.id)),
  );
  return [
    ...others,
    ...payments.map(paymentAttentionItem),
    ...signIns.map(signInAttentionItem),
  ].sort(compareAttentionItems);
}
