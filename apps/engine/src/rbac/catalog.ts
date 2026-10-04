import permissionsJson from "./permissions.json" with { type: "json" };

export interface Permission {
  name: string;
  description: string;
  resource_type: string;
}

const frozen = Object.freeze(
  (permissionsJson as Permission[]).map((p) => Object.freeze({ ...p })),
) as readonly Permission[];

const byName = new Map<string, Permission>();
for (const p of frozen) byName.set(p.name, p);

export function loadPermissionCatalog(): readonly Permission[] {
  return frozen;
}

export function getPermissionByName(name: string): Permission | undefined {
  return byName.get(name);
}

export const ALL_PERMISSION_NAMES: readonly string[] = Object.freeze(frozen.map((p) => p.name));
