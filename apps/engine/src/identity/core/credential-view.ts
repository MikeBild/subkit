import type { ApiKeyCreator } from "./credentials.ts";

export interface ApiKeyView {
  id: string;
  tenant_id: string;
  prefix: string;
  name: string | null;
  scopes: string[];
  user_id: string | null;
  system_account_id: string | null;
  creator: ApiKeyCreator | null;
  allowed_workflows: string[] | null;
  allowed_connectors: string[] | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  rotating_out_at: Date | null;
  rotated_from_id: string | null;
  revoked_at: Date | null;
}

export type ApiKeyViewFacts = Readonly<Omit<ApiKeyView, "creator">> &
  Readonly<{
    creator_kind: string | null;
    creator_id: string | null;
  }>;

export function toApiKeyView(row: ApiKeyViewFacts): ApiKeyView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    prefix: row.prefix,
    name: row.name ?? null,
    scopes: row.scopes,
    user_id: row.user_id ?? null,
    system_account_id: row.system_account_id ?? null,
    creator:
      row.creator_kind === "user" && row.creator_id
        ? { kind: "user", id: row.creator_id }
        : row.creator_kind === "system_account" && row.creator_id
          ? { kind: "system_account", id: row.creator_id }
          : row.creator_kind === "system" && row.creator_id === null
            ? { kind: "system", id: null }
            : null,
    allowed_workflows: row.allowed_workflows ?? null,
    allowed_connectors: row.allowed_connectors ?? null,
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
    expires_at: row.expires_at ?? null,
    rotating_out_at: row.rotating_out_at ?? null,
    rotated_from_id: row.rotated_from_id ?? null,
    revoked_at: row.revoked_at ?? null,
  };
}
