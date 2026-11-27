import type { VaultFillOutcome } from "@shared/device/browser.ts";
import type { CardValue, LoginValue } from "@shared/vault-kinds.ts";
import type { VaultPaymentStatus, VaultUseStatus } from "@shared/vault-uses.ts";

export const SECRET_TICKET_TTL_MS = 60_000;
export const PAYMENT_APPROVAL_TTL_MS = 15 * 60_000;

export const PAY_RESULT_NOTE = "submitted, not confirmed paid — do not submit again";
export const SIGN_IN_RESULT_NOTE =
  "the sign-in form was filled and submitted; check the page with a new snapshot, and never repeat the sign-in on an uncertain outcome";

const USE_STEPS: Readonly<Record<VaultUseStatus, readonly VaultUseStatus[]>> = {
  pending: ["running", "failed"],
  running: ["submitted", "uncertain", "failed"],
  submitted: [],
  uncertain: [],
  failed: [],
};

export function useStepAllowed(from: VaultUseStatus, to: VaultUseStatus): boolean {
  return USE_STEPS[from].includes(to);
}

export function useStatusesBefore(to: VaultUseStatus): VaultUseStatus[] {
  return (Object.keys(USE_STEPS) as VaultUseStatus[]).filter((from) => useStepAllowed(from, to));
}

export type PaymentAction = "approve" | "reject" | "expire" | "consume";

const PAYMENT_STEPS: Readonly<
  Record<PaymentAction, readonly [VaultPaymentStatus, VaultPaymentStatus]>
> = {
  approve: ["pending", "approved"],
  reject: ["pending", "rejected"],
  expire: ["pending", "expired"],
  consume: ["approved", "consumed"],
};

export function paymentStep(action: PaymentAction): {
  readonly from: VaultPaymentStatus;
  readonly to: VaultPaymentStatus;
} {
  const [from, to] = PAYMENT_STEPS[action];
  return { from, to };
}

export type PaymentRefusal = "payment_not_pending" | "payment_expired" | "not_card_owner";

export function paymentDecisionRefusal(
  payment: {
    readonly status: VaultPaymentStatus;
    readonly owner_user_id: string;
    readonly expires_at: Date;
  },
  actor_id: string,
  now: Date,
): PaymentRefusal | null {
  if (payment.owner_user_id !== actor_id) return "not_card_owner";
  if (payment.status !== "pending") return "payment_not_pending";
  if (now.getTime() >= payment.expires_at.getTime()) return "payment_expired";
  return null;
}

export function cvvValid(cvv: string): boolean {
  return /^[0-9]{3,4}$/u.test(cvv);
}

export function useStatusOfOutcome(
  outcome: VaultFillOutcome | "failed" | "unknown",
  filled: boolean,
): VaultUseStatus {
  if (outcome === "submitted") return "submitted";
  if (outcome === "refused" && !filled) return "failed";
  if (outcome === "failed" && !filled) return "failed";
  return "uncertain";
}

export function signInTicketValues(
  login: LoginValue,
  kind: "password" | "totp",
  fields: { readonly username?: string; readonly password?: string; readonly code?: string },
): Record<string, string> {
  return {
    ...(fields.username ? { username: login.username } : {}),
    ...(fields.password ? { password: login.password } : {}),
    ...((kind === "totp" || fields.code) && login.totp_seed ? { totp_seed: login.totp_seed } : {}),
  };
}

export function payTicketValues(card: CardValue, cvv: string): Record<string, string> {
  return {
    number: card.number.replace(/[\s-]/gu, ""),
    exp_month: String(card.exp_month).padStart(2, "0"),
    exp_year: String(card.exp_year).padStart(4, "20"),
    holder: card.holder,
    cvv,
  };
}

export function ticketAad(tenant_id: string, ticket_id: string): string {
  return `ticket:${tenant_id}:${ticket_id}`;
}
