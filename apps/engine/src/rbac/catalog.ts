// Permission catalog loader.
//
// The permission catalog is a static JSON file imported at boot. Each
// entry shape: `{ name, description, resource_type }`. The `name`
// column is the stable identifier referenced by `requirePermission`
// and the RBAC evaluator — never change a name, only add new ones.
//
// `loadPermissionCatalog()` returns a frozen copy so callers cannot
// mutate the shared catalog. `ALL_PERMISSION_NAMES` is derived at
// module load so routes can validate strings against a runtime
// allow-list without importing the JSON directly.

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
