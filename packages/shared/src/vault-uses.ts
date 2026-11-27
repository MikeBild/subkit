export const VAULT_USE_PURPOSES = ["sign_in", "pay"] as const;
export type VaultUsePurpose = (typeof VAULT_USE_PURPOSES)[number];

export const VAULT_USE_STATUSES = [
  "pending",
  "running",
  "submitted",
  "uncertain",
  "failed",
] as const;
export type VaultUseStatus = (typeof VAULT_USE_STATUSES)[number];

export const VAULT_PAYMENT_STATUSES = [
  "pending",
  "approved",
  "consumed",
  "expired",
  "rejected",
] as const;
export type VaultPaymentStatus = (typeof VAULT_PAYMENT_STATUSES)[number];
