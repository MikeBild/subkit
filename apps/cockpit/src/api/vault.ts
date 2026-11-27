import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";
import { respondToToolCallStream } from "./client";

type VaultItem = components["schemas"]["VaultItem"];
type VaultItemCreate = components["schemas"]["VaultItemCreate"];
type VaultItemUpdate = components["schemas"]["VaultItemUpdate"];
type VaultImport = components["schemas"]["VaultImport"];
type VaultImportResult = components["schemas"]["VaultImportResult"];
type VaultItemReveal = components["schemas"]["VaultItemReveal"];
type VaultActivity = components["schemas"]["VaultItemActivity"];

export const VAULT_KEY = ["vault"] as const;

export function vaultActivityKey(id: string) {
  return [...VAULT_KEY, id, "activity"] as const;
}

export async function listVaultItems(): Promise<VaultItem[]> {
  return (await apiCall("get", "/v1/vault", {})).items;
}

export function createVaultItem(body: VaultItemCreate): Promise<VaultItem> {
  return apiCall("post", "/v1/vault", { body });
}

export function updateVaultItem(id: string, body: VaultItemUpdate): Promise<VaultItem> {
  return apiCall("patch", "/v1/vault/{id}", { path: { id }, body });
}

export async function deleteVaultItem(id: string): Promise<void> {
  await apiCall("delete", "/v1/vault/{id}", { path: { id } });
}

export function revealVaultItem(id: string): Promise<VaultItemReveal> {
  return apiCall("post", "/v1/vault/{id}/reveal", { path: { id } });
}

export async function listVaultActivity(id: string): Promise<VaultActivity["items"]> {
  return (await apiCall("get", "/v1/vault/{id}/activity", { path: { id } })).items;
}

export type PaymentWire = components["schemas"]["VaultPayment"];
export type PaymentDecisionWire = components["schemas"]["VaultPaymentDecision"];
export type PaymentResume = NonNullable<PaymentDecisionWire["resume"]>;

export const VAULT_PAYMENTS_KEY = [...VAULT_KEY, "payments", "pending"] as const;

export async function listPendingPayments(): Promise<PaymentWire[]> {
  return (await apiCall("get", "/v1/vault/payments", { query: { status: "pending" } })).items;
}

export function approvePayment(id: string, cvv: string): Promise<PaymentDecisionWire> {
  return apiCall("post", "/v1/vault/payments/{id}/approve", { path: { id }, body: { cvv } });
}

export function rejectPayment(id: string): Promise<PaymentDecisionWire> {
  return apiCall("post", "/v1/vault/payments/{id}/reject", { path: { id } });
}

export interface ResumedStep {
  finished: Promise<unknown>;
}

export function resumePaymentStep(
  resume: PaymentResume,
  confirmed: boolean,
  stream: typeof respondToToolCallStream = respondToToolCallStream,
): Promise<ResumedStep> {
  return new Promise((accept, refuse) => {
    let settled = false;
    const once = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    const finished = stream(resume.conversation_id, resume.tool_call_id, { confirmed }, () =>
      once(() => accept({ finished })),
    );
    finished.then(
      () => once(() => accept({ finished })),
      (error: unknown) => once(() => refuse(error)),
    );
  });
}

export function importVaultCsv(body: VaultImport): Promise<VaultImportResult> {
  return apiCall("post", "/v1/vault/import", { body });
}
