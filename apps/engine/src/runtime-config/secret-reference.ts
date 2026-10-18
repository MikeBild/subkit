import { RuntimeConfigValidationError } from "./contracts.ts";

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const SECRET_REF = /^secret:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})\/([1-9][0-9]*)$/;

export function parseSecretReference(value: string): { name: string; version: number } | null {
  const match = SECRET_REF.exec(value);
  if (!match) return null;
  return { name: match[1]!, version: Number(match[2]) };
}

export function secretReference(name: string, version: number): string {
  return `secret://${name}/${version}`;
}

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

export function containsSecretReference(value: unknown): boolean {
  if (typeof value === "string") return parseSecretReference(value) !== null;
  if (Array.isArray(value)) return value.some(containsSecretReference);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsSecretReference);
}

export function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) {
    throw new RuntimeConfigValidationError(
      "secret name must match [A-Za-z0-9][A-Za-z0-9._-]{0,254}",
    );
  }
}
