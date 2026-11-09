export type AdministratorChangeDecision =
  | Readonly<{ kind: "allowed" }>
  | Readonly<{ kind: "needs_active_users" }>
  | Readonly<{ kind: "rejected"; reason: "last_admin" }>;

export function decideAdministratorChange(
  userId: string,
  nextEffectiveRole: string | null,
  activeUsers: readonly Readonly<{ id: string; assigned: string | null }>[] | null,
): AdministratorChangeDecision {
  if (nextEffectiveRole === "admin") return { kind: "allowed" };
  if (activeUsers === null) return { kind: "needs_active_users" };
  const administrators = activeUsers.filter((user) => user.assigned === "admin");
  if (!administrators.some((user) => user.id === userId)) return { kind: "allowed" };
  return administrators.length <= 1
    ? { kind: "rejected", reason: "last_admin" }
    : { kind: "allowed" };
}
