export type ApiKeyCreator =
  | { kind: "user"; id: string }
  | { kind: "system_account"; id: string }
  | { kind: "system"; id: null };

export type ApiKeyOwnerKind = "user" | "system_account";

export interface CredentialOwnerFacts {
  owner_kind: ApiKeyOwnerKind;
  owner_id: string | null | undefined;
  owner_found_in_tenant: boolean;
}

export type CredentialOwnerDecision =
  | Readonly<{ kind: "accepted"; owner_kind: ApiKeyOwnerKind; owner_id: string }>
  | Readonly<{ kind: "owner_missing"; owner_kind: ApiKeyOwnerKind }>
  | Readonly<{ kind: "owner_not_in_tenant"; owner_kind: ApiKeyOwnerKind }>;

export function apiKeyActorId(actor: Readonly<ApiKeyCreator> | null | undefined): string | null {
  return actor?.id ?? null;
}

export function decideCredentialCreator(
  actor: Readonly<ApiKeyCreator> | null | undefined,
  actorId: string | null | undefined,
):
  | Readonly<{ kind: "accepted"; actor: ApiKeyCreator | null }>
  | Readonly<{ kind: "provenance_mismatch" }> {
  if (actor === undefined) return { kind: "accepted", actor: null };
  if (actorId !== undefined && actorId !== apiKeyActorId(actor))
    return { kind: "provenance_mismatch" };
  return { kind: "accepted", actor };
}

function ownerFacts(
  existing: Readonly<{ user_id: string | null; system_account_id: string | null }>,
) {
  return {
    owner_kind: existing.user_id ? ("user" as const) : ("system_account" as const),
    owner_id: existing.user_id ?? existing.system_account_id,
  };
}

export function decideApiKeyRotationOwner(
  existing: Readonly<{ user_id: string | null; system_account_id: string | null }>,
):
  | Readonly<{ kind: "owner_missing"; owner_kind: "user" | "system_account" }>
  | Readonly<{ kind: "accepted"; owner_kind: "user" | "system_account"; owner_id: string }> {
  const { owner_kind, owner_id } = ownerFacts(existing);
  if (!owner_id) return { kind: "owner_missing", owner_kind };
  return { kind: "accepted", owner_kind, owner_id };
}

export function decideCredentialIssue(
  facts: Readonly<CredentialOwnerFacts>,
): CredentialOwnerDecision {
  if (!facts.owner_id) return { kind: "owner_missing", owner_kind: facts.owner_kind };
  if (!facts.owner_found_in_tenant)
    return { kind: "owner_not_in_tenant", owner_kind: facts.owner_kind };
  return { kind: "accepted", owner_kind: facts.owner_kind, owner_id: facts.owner_id };
}

export function decideApiKeyRotation(
  existing: Readonly<{ user_id: string | null; system_account_id: string | null }>,
  facts: Readonly<Omit<CredentialOwnerFacts, "owner_kind" | "owner_id">>,
): CredentialOwnerDecision {
  const owner = ownerFacts(existing);
  return decideCredentialIssue({
    ...facts,
    owner_kind: owner.owner_kind,
    owner_id: owner.owner_id,
  });
}

export function rotationOverlapDeadline(
  now_ms: number,
  overlap_minutes: number | undefined,
): number {
  return now_ms + (overlap_minutes ?? 60) * 60_000;
}
