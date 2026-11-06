import type { PrincipalKind } from "../auth/types.ts";

export interface VersionActor {
  actor_id?: string | null;
  actor_type?: PrincipalKind | "system" | "unknown" | undefined;
}

interface VersionAuthorColumns {
  author_user_id: string | null;
  author_system_account_id: string | null;
}

export type VersionAuthor = { kind: PrincipalKind; id: string } | null;

export function versionAuthorColumns(actor: VersionActor): VersionAuthorColumns {
  return {
    author_user_id: actor.actor_type === "user" ? (actor.actor_id ?? null) : null,
    author_system_account_id:
      actor.actor_type === "system_account" ? (actor.actor_id ?? null) : null,
  };
}

export function readVersionAuthor(row: VersionAuthorColumns): VersionAuthor {
  if (row.author_user_id && !row.author_system_account_id)
    return { kind: "user", id: row.author_user_id };
  if (row.author_system_account_id && !row.author_user_id)
    return { kind: "system_account", id: row.author_system_account_id };
  return null;
}
