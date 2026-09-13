import { and, desc, eq } from "drizzle-orm";

import { generateCredentialSetupGrant } from "../connectors/credential-setup-grant.ts";
import { buildOAuthRedirectUri, OAUTH_CALLBACK_PATH } from "../credentials/oauth2/redirect-uri.ts";
import { secureEqual } from "../crypto/aes-gcm.ts";
import type { Db } from "../db/client.ts";
import { conversationElicitations } from "../db/schema/index.ts";
import { now } from "../utils/clock.ts";
import { loadDraft } from "./draft.ts";

export const DRAFT_CREDENTIAL_SETUP_KIND = "connector_draft_credential_setup";
export const DRAFT_CREDENTIAL_SETUP_TTL_MS = 10 * 60_000;

export type DraftCredentialSetupAuthType = "bearer" | "basic" | "header" | "query" | "aws_sigv4";

export function isDraftCredentialSetupAuthType(
  value: string,
): value is DraftCredentialSetupAuthType {
  return (
    value === "bearer" ||
    value === "basic" ||
    value === "header" ||
    value === "query" ||
    value === "aws_sigv4"
  );
}

export type MintDraftCredentialSetupResult =
  { ok: true; url: string; expires_at: Date } | { ok: false; error: "engine_public_url_missing" };

export function mintDraftCredentialSetupUrl(
  conversation_id: string,
): MintDraftCredentialSetupResult {
  const redirectUri = buildOAuthRedirectUri();
  if (!redirectUri) return { ok: false, error: "engine_public_url_missing" };
  const origin = redirectUri.slice(0, -OAUTH_CALLBACK_PATH.length);
  const { plaintext } = generateCredentialSetupGrant();
  const expires_at = new Date(now() + DRAFT_CREDENTIAL_SETUP_TTL_MS);
  return {
    ok: true,
    url:
      `${origin}/v1/connector-drafts/${conversation_id}/credentials/setup` +
      `?grant=${encodeURIComponent(plaintext)}`,
    expires_at,
  };
}

export interface ValidatedDraftCredentialSetup {
  tenant_id: string;
  conversation_id: string;
  elicitation_id: string;
  auth_type: DraftCredentialSetupAuthType;
  connector_label: string;
}

export async function validateDraftCredentialSetup(
  db: Db,
  opts: { conversation_id: string; grant: string },
): Promise<ValidatedDraftCredentialSetup | null> {
  // tenant-filter:exempt — this unauthenticated capability route derives the
  // tenant only after the opaque single-use grant matches a pending row.
  const rows = await db
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.conversation_id, opts.conversation_id),
        eq(conversationElicitations.status, "pending"),
      ),
    )
    .orderBy(desc(conversationElicitations.created_at));

  for (const row of rows) {
    if (
      row.delivery_last_error === "url_credential_claimed" ||
      row.delivery_last_error === "url_completed" ||
      row.delivery_last_error === "url_failed"
    ) {
      continue;
    }
    if (!row.input || typeof row.input !== "object" || Array.isArray(row.input)) continue;
    const input = row.input as Record<string, unknown>;
    if (input.kind !== DRAFT_CREDENTIAL_SETUP_KIND) continue;
    if (typeof input.setup_url !== "string" || typeof input.expires_at !== "string") continue;
    const expiresAt = Date.parse(input.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) continue;

    let storedGrant: string;
    try {
      storedGrant = new URL(input.setup_url).searchParams.get("grant") ?? "";
    } catch {
      continue;
    }
    if (!storedGrant || !secureEqual(storedGrant, opts.grant)) continue;

    const draft = await loadDraft(row.tenant_id, opts.conversation_id, db);
    const connector = draft.connector;
    if (!connector || connector.saved_connector_id) return null;
    const authType = connector.auth_type ?? "none";
    if (!isDraftCredentialSetupAuthType(authType) || input.auth_type !== authType) return null;

    return {
      tenant_id: row.tenant_id,
      conversation_id: opts.conversation_id,
      elicitation_id: row.id,
      auth_type: authType,
      connector_label: connector.name ?? connector.slug ?? "connector",
    };
  }
  return null;
}
