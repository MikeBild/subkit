import type { CredentialOrigin } from "../../auth/types.ts";
import type { ApiKeyCreator } from "./credentials.ts";

interface CredentialRecordFacts {
  readonly tenant_id: string;
  readonly user_id: string | null;
  readonly system_account_id: string | null;
  readonly name?: string | null;
  readonly scopes: string[];
  readonly allowed_workflows?: string[] | null;
  readonly allowed_connectors?: string[] | null;
  readonly expires_at?: Date | null;
  readonly rotated_from_id?: string | null;
  readonly credential_origin: CredentialOrigin | null;
}

export function credentialStorageValues(
  facts: CredentialRecordFacts,
  actor: Readonly<ApiKeyCreator> | null,
  key: Readonly<{ prefix: string; hash: string }>,
) {
  return {
    tenant_id: facts.tenant_id,
    user_id: facts.user_id,
    system_account_id: facts.system_account_id,
    creator_kind: actor?.kind ?? null,
    creator_id: actor?.kind === "system" ? null : (actor?.id ?? null),
    credential_origin: facts.credential_origin,
    prefix: key.prefix,
    token_sha256: key.hash,
    name: facts.name ?? null,
    scopes: facts.scopes,
    allowed_workflows: facts.allowed_workflows ?? null,
    allowed_connectors: facts.allowed_connectors ?? null,
    expires_at: facts.expires_at ?? null,
    rotated_from_id: facts.rotated_from_id ?? null,
  };
}

export function credentialIssueMetadata(
  facts: Readonly<{
    owner_kind: "user" | "system_account";
    owner_id: string | null;
    prefix: string;
    rotated_from_id?: string | null;
  }>,
) {
  return {
    owner_kind: facts.owner_kind,
    owner_id: facts.owner_id,
    prefix: facts.prefix,
    rotated_from_id: facts.rotated_from_id ?? null,
  };
}
