const LEGACY_ROLE_NAMES = new Set(["admin", "member", "enduser"]);

export function resolveEffectiveUserRole(
  legacyRole: string,
  assignedRoleName: string | null | undefined,
): string {
  return assignedRoleName ?? legacyRole;
}

export function hasLegacyRoleDrift(
  legacyRole: string,
  assignedRoleName: string | null | undefined,
): boolean {
  return Boolean(
    assignedRoleName && LEGACY_ROLE_NAMES.has(assignedRoleName) && assignedRoleName !== legacyRole,
  );
}
