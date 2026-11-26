export const adminKeys = {
  all: ["admin"] as const,
  people: () => [...adminKeys.all, "people"] as const,
  peopleList: (app: string | null) => [...adminKeys.people(), "list", app ?? "all"] as const,
  roles: () => [...adminKeys.all, "roles"] as const,
  role: (id: string | undefined) => [...adminKeys.all, "role", id] as const,
  groups: () => [...adminKeys.all, "groups"] as const,
  grants: () => [...adminKeys.all, "grants"] as const,
  permissions: () => [...adminKeys.all, "permissions"] as const,
  workflows: () => [...adminKeys.all, "workflows"] as const,
  connectors: () => [...adminKeys.all, "connectors"] as const,
};
