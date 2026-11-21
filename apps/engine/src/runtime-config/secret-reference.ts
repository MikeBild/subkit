import { isSecretName, parseSecretReference } from "@shared/vault-handle.ts";
import { RuntimeConfigValidationError } from "./contracts.ts";

export function settingSecretName(
  tenantId: string | undefined,
  leafPath: readonly string[],
): string {
  const leaf = leafPath.join(".");
  return tenantId ? `tenants.${tenantId}.settings.${leaf}` : `settings.${leaf}`;
}

export function ownsTenantSettingSecret(
  value: unknown,
  tenantId: string,
  leafPath: readonly string[],
): boolean {
  if (typeof value !== "string") return false;
  return parseSecretReference(value)?.name === settingSecretName(tenantId, leafPath);
}

export function assertSecretName(name: string): void {
  if (!isSecretName(name)) {
    throw new RuntimeConfigValidationError(
      "secret name must match [A-Za-z0-9][A-Za-z0-9._-]{0,254}",
    );
  }
}
