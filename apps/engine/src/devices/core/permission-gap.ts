export const COMPUTER_PERMISSIONS = ["accessibility", "screen"] as const;
export type ComputerPermission = (typeof COMPUTER_PERMISSIONS)[number];

export function missingPermissions(reported: unknown): ComputerPermission[] {
  const facts = (reported ?? {}) as { capabilities?: unknown; permissions?: unknown };
  if (!Array.isArray(facts.capabilities) || !facts.capabilities.includes("computer")) return [];
  const permissions = (facts.permissions ?? {}) as Record<string, unknown>;
  return COMPUTER_PERMISSIONS.filter((name) => permissions[name] !== true);
}
