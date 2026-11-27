import { createHash } from "node:crypto";

export interface VaultAadSubject {
  readonly tenant_id: string;
  readonly owner_user_id: string | null;
  readonly id: string;
  readonly kind: string;
}

export function vaultItemAadV1(tenant_id: string, id: string): string {
  return `credential:${tenant_id}:${id}`;
}

export function vaultItemAadV2(subject: VaultAadSubject): string {
  const owner = subject.owner_user_id ?? "workspace";
  return `vault:v2:${subject.tenant_id}:${owner}:${subject.id}:${subject.kind}`;
}

export function vaultItemAadCandidates(subject: VaultAadSubject): readonly string[] {
  return [vaultItemAadV2(subject), vaultItemAadV1(subject.tenant_id, subject.id)];
}

export function sha256HexOfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
