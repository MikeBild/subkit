export type UserChangePatch = Readonly<{
  role_id?: string;
  display_name?: string | null;
}>;

export type UserChangeDecision =
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{
      kind: "apply";
      patch: UserChangePatch;
      role_changed: boolean;
      profile_changed: boolean;
      next_role_id: string;
    }>;

export function decideUserChange(
  current: Readonly<{ role_id: string; display_name: string | null }>,
  command: UserChangePatch,
): UserChangeDecision {
  const role_changed = command.role_id !== undefined && command.role_id !== current.role_id;
  const profile_changed =
    command.display_name !== undefined && command.display_name !== current.display_name;
  if (!role_changed && !profile_changed) return { kind: "unchanged" };
  return {
    kind: "apply",
    patch: { ...command },
    role_changed,
    profile_changed,
    next_role_id: command.role_id ?? current.role_id,
  };
}
