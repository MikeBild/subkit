import type { PaymentDecisionWire, PaymentResume, PaymentWire } from "@/api/vault";
import { LOCALE_TAGS, type Locale, type TranslationKey } from "@/lib/i18n";
import { brandName } from "./entries";

export type PaymentStatus = "pending" | "approved" | "consumed" | "expired" | "rejected";

export interface Payment {
  id: string;
  status: PaymentStatus;
  origin: string;
  host: string;
  amountMinor: number;
  currency: string;
  expiresAt: string | null;
  brand: string | null;
  last4: string | null;
  cardName: string | null;
}

const UUID = /^[0-9a-f-]{36}$/i;

const STATUSES: readonly PaymentStatus[] = [
  "pending",
  "approved",
  "consumed",
  "expired",
  "rejected",
];

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function paymentView(wire: Pick<PaymentWire, "id"> & Partial<PaymentWire>): Payment {
  const status = STATUSES.find((value) => value === wire.status) ?? "pending";
  const origin = wire.origin ?? "";
  return {
    id: wire.id,
    status,
    origin,
    host: hostOf(origin),
    amountMinor: typeof wire.amount_minor === "number" ? wire.amount_minor : 0,
    currency: (wire.currency ?? "EUR").toUpperCase(),
    expiresAt: wire.expires_at ?? null,
    brand: wire.card?.brand ?? null,
    last4: wire.card?.last4 ?? null,
    cardName: null,
  };
}

export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export function formatMinor(locale: Locale, minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const amount = minor / 10 ** digits;
  try {
    return new Intl.NumberFormat(LOCALE_TAGS[locale], {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
}

export function secondsLeft(expiresAt: string | null, now: number): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export function countdownLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function cardLabel(payment: Pick<Payment, "brand" | "last4">): string | null {
  if (!payment.last4) return null;
  const brand = brandName(payment.brand);
  return brand ? `${brand} •••• ${payment.last4}` : `•••• ${payment.last4}`;
}

export function cvvLength(brand: string | null): readonly number[] {
  if (brand === "amex") return [4];
  if (brand && brandName(brand)) return [3];
  return [3, 4];
}

export function cvvProblem(cvv: string, brand: string | null): TranslationKey | null {
  if (cvv === "") return "vault.payment.cvvMissing";
  if (!/^\d+$/.test(cvv)) return "vault.payment.cvvDigits";
  const lengths = cvvLength(brand);
  if (lengths.includes(cvv.length)) return null;
  return lengths.length === 1 && lengths[0] === 4
    ? "vault.payment.cvvFour"
    : lengths.length === 1
      ? "vault.payment.cvvThree"
      : "vault.payment.cvvLength";
}

export function onlyDigits(raw: string, max = 4): string {
  return raw.replace(/\D/g, "").slice(0, max);
}

export type PanelPhase = "idle" | "approving" | "rejecting" | "submitted" | "rejected";

export interface PendingResume {
  resume: PaymentResume;
  confirmed: boolean;
}

export interface PanelState {
  cvv: string;
  touched: boolean;
  phase: PanelPhase;
  error: TranslationKey | null;
  resumeFailed: PendingResume | null;
}

export type PanelEvent =
  | { type: "type"; cvv: string }
  | { type: "invalid" }
  | { type: "approve" }
  | { type: "reject" }
  | { type: "approved" }
  | { type: "rejected" }
  | { type: "resumeFailed"; pending: PendingResume }
  | { type: "resumed" }
  | { type: "failed"; error: TranslationKey }
  | { type: "close" };

export const PANEL_START: PanelState = {
  cvv: "",
  touched: false,
  phase: "idle",
  error: null,
  resumeFailed: null,
};

export function panelStep(state: PanelState, event: PanelEvent): PanelState {
  switch (event.type) {
    case "type":
      return { ...state, cvv: onlyDigits(event.cvv), error: null };
    case "invalid":
      return { ...state, touched: true, error: null };
    case "approve":
      return { ...PANEL_START, phase: "approving" };
    case "reject":
      return { ...PANEL_START, phase: "rejecting" };
    case "approved":
      return { ...PANEL_START, phase: "submitted" };
    case "rejected":
      return { ...PANEL_START, phase: "rejected" };
    case "resumeFailed":
      return { ...state, resumeFailed: event.pending };
    case "resumed":
      return { ...state, resumeFailed: null };
    case "failed":
      return { ...PANEL_START, error: event.error };
    case "close":
      return PANEL_START;
  }
}

export function paymentErrorKey(error: unknown): TranslationKey {
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : null;
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (status === 410 || /expired/.test(code)) return "vault.payment.error.expired";
  if (status === 409) return "vault.payment.error.settled";
  if (status === 403) return "vault.payment.error.forbidden";
  if (status === 404) return "vault.payment.error.notFound";
  if (status === 400 || status === 422) return "vault.payment.error.cvv";
  return "vault.payment.error.generic";
}

export interface ApproveInput {
  id: string;
  cvv: string;
}

export interface DecisionPorts {
  approve(id: string, cvv: string): Promise<Pick<PaymentDecisionWire, "resume">>;
  reject(id: string): Promise<Pick<PaymentDecisionWire, "resume">>;
  resume(resume: PaymentResume, confirmed: boolean): Promise<unknown>;
}

export type DecisionInput =
  | { kind: "approve"; id: string; cvv: string }
  | { kind: "reject"; id: string };

export interface DecisionOutcome {
  pending: PendingResume | null;
  resumed: boolean;
}

function resumeTarget(decision: Pick<PaymentDecisionWire, "resume">): PaymentResume | null {
  const resume = decision.resume;
  return resume?.conversation_id && resume.tool_call_id
    ? { conversation_id: resume.conversation_id, tool_call_id: resume.tool_call_id }
    : null;
}

export async function resumeChat(
  resume: DecisionPorts["resume"],
  pending: PendingResume,
): Promise<boolean> {
  try {
    await resume(pending.resume, pending.confirmed);
    return true;
  } catch {
    return false;
  }
}

export async function decidePayment(
  ports: DecisionPorts,
  input: DecisionInput,
): Promise<DecisionOutcome> {
  const decision =
    input.kind === "approve"
      ? await ports.approve(input.id, input.cvv)
      : await ports.reject(input.id);
  const target = resumeTarget(decision);
  if (!target) return { pending: null, resumed: false };
  const pending = { resume: target, confirmed: input.kind === "approve" };
  return { pending, resumed: await resumeChat(ports.resume, pending) };
}

export function approvalMutation<T>(approve: (id: string, cvv: string) => Promise<T>) {
  return {
    mutationFn: (input: ApproveInput) => approve(input.id, input.cvv),
    gcTime: 0,
    retry: false,
    meta: { sensitive: true },
  } as const;
}

export function paymentFromUrl(search: string): string | null {
  const id = new URLSearchParams(search).get("payment")?.trim() ?? "";
  return UUID.test(id) ? id : null;
}

export function vaultItemFromUrl(search: string): string | null {
  const id = new URLSearchParams(search).get("item")?.trim() ?? "";
  return UUID.test(id) ? id : null;
}

export function withVaultItem(
  location: Pick<Location, "pathname" | "search">,
  itemId: string | null,
): Pick<Location, "pathname" | "search"> {
  const params = new URLSearchParams(location.search);
  if (itemId) params.set("item", itemId);
  else params.delete("item");
  const search = params.toString();
  return { pathname: location.pathname, search: search ? `?${search}` : "" };
}
