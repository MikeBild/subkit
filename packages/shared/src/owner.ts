export interface OwnerFacts {
  readonly id: string;
  readonly is_admin: boolean;
}

export function isBuiltinAdmin(roles: readonly string[] | undefined): boolean {
  return roles?.includes("admin") === true;
}

export function ownerFactsOf(principal: {
  readonly id: string;
  readonly roles?: readonly string[];
}): OwnerFacts {
  return { id: principal.id, is_admin: isBuiltinAdmin(principal.roles) };
}

export function isOwner(viewer: Pick<OwnerFacts, "id">, owner_id: string | null): boolean {
  return owner_id !== null && owner_id === viewer.id;
}

export function isOwnerOrAdmin(viewer: OwnerFacts, owner_id: string | null): boolean {
  return viewer.is_admin || isOwner(viewer, owner_id);
}
