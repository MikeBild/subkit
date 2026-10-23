import { and, desc, eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { generateCredentialSetupGrant } from "../connectors/credential-setup-grant.ts";
import { buildOAuthRedirectUri, OAUTH_CALLBACK_PATH } from "../credentials/oauth2/redirect-uri.ts";
import { secureEqual } from "../crypto/aes-gcm.ts";
import type { Db } from "../db/client.ts";
import { conversationElicitations } from "../db/schema/index.ts";
import { now } from "../utils/clock.ts";
import { loadDraft } from "./draft.ts";

export const DRAFT_CREDENTIAL_SETUP_KIND = "connector_draft_credential_setup";
export const DRAFT_CREDENTIAL_SETUP_TTL_MS = 10 * 60_000;
export const DRAFT_CREDENTIAL_SETUP_MAX_REISSUES = 5;

const SUBMITTED_DELIVERY_STATES: ReadonlySet<string> = new Set([
  "url_credential_claimed",
  "url_completed",
  "url_failed",
]);

export type DraftCredentialSetupAuthType =
  | "bearer"
  | "basic"
  | "header"
  | "query"
  | "aws_sigv4"
  | "signed_jwt";

export function isDraftCredentialSetupAuthType(
  value: string,
): value is DraftCredentialSetupAuthType {
  return (
    value === "bearer" ||
    value === "basic" ||
    value === "header" ||
    value === "query" ||
    value === "signed_jwt" ||
    value === "aws_sigv4"
  );
}

export type MintDraftCredentialSetupResult =
  | { ok: true; url: string; expires_at: Date }
  | { ok: false; error: "engine_public_url_missing" };

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
  connector_config: Record<string, unknown>;
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
    if (row.delivery_last_error && SUBMITTED_DELIVERY_STATES.has(row.delivery_last_error)) {
      continue;
    }
    if (!row.input || typeof row.input !== "object" || Array.isArray(row.input)) continue;
    const input = row.input as Record<string, unknown>;
    if (input.kind !== DRAFT_CREDENTIAL_SETUP_KIND) continue;
    if (typeof input.setup_url !== "string" || typeof input.expires_at !== "string") continue;
    const expiresAt = Date.parse(input.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) continue;

    let storedGrant = "";
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
      connector_config: connector.config ?? {},
    };
  }
  return null;
}

export function draftCredentialSetupNote(url: string, expires_at: Date): string {
  return (
    `Present this secure setup link to the operator verbatim, as a bare URL on its own line: ${url} ` +
    `It expires at ${expires_at.toISOString()} and is single-use. ` +
    "The operator enters the credential there; then call probe_connector_draft. " +
    "Do NOT ask them to paste the secret in chat."
  );
}

export type ReissueDraftCredentialSetupResult =
  | { reissued: true; input: Record<string, unknown>; expires_at: Date }
  | {
      reissued: false;
      reason:
        | "not_credential_setup"
        | "still_valid"
        | "reissue_limit"
        | "engine_public_url_missing"
        | "no_longer_pending";
    };

export interface ReissueDeps {
  mint: typeof mintDraftCredentialSetupUrl;
  audit: typeof auditAwait;
}

const REISSUE_DEPS: ReissueDeps = { mint: mintDraftCredentialSetupUrl, audit: auditAwait };

export async function reissueExpiredDraftCredentialSetup(
  db: Db,
  p: {
    tenant_id: string;
    conversation_id: string;
    elicitation_id: string;
    input: unknown;
    delivery_last_error?: string | null;
    principal: Pick<ResolvedPrincipal, "kind" | "id">;
  },
  deps: ReissueDeps = REISSUE_DEPS,
): Promise<ReissueDraftCredentialSetupResult> {
  if (!p.input || typeof p.input !== "object" || Array.isArray(p.input)) {
    return { reissued: false, reason: "not_credential_setup" };
  }
  const input = p.input as Record<string, unknown>;
  if (input.kind !== DRAFT_CREDENTIAL_SETUP_KIND || typeof input.setup_url !== "string") {
    return { reissued: false, reason: "not_credential_setup" };
  }
  if (p.delivery_last_error && SUBMITTED_DELIVERY_STATES.has(p.delivery_last_error)) {
    return { reissued: false, reason: "no_longer_pending" };
  }
  const expiresAt = typeof input.expires_at === "string" ? Date.parse(input.expires_at) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt > now()) {
    return { reissued: false, reason: "still_valid" };
  }
  const reissues = typeof input.reissue_count === "number" ? input.reissue_count : 0;
  if (reissues >= DRAFT_CREDENTIAL_SETUP_MAX_REISSUES) {
    return { reissued: false, reason: "reissue_limit" };
  }
  const grant = deps.mint(p.conversation_id);
  if (!grant.ok) return { reissued: false, reason: grant.error };
  const next: Record<string, unknown> = {
    ...input,
    setup_url: grant.url,
    expires_at: grant.expires_at.toISOString(),
    note: draftCredentialSetupNote(grant.url, grant.expires_at),
    reissue_count: reissues + 1,
  };
  const [row] = await db
    .update(conversationElicitations)
    .set({
      input: next,
      expires_at: grant.expires_at,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.conversation_id, p.conversation_id),
        eq(conversationElicitations.id, p.elicitation_id),
        eq(conversationElicitations.status, "pending"),
        sql`${conversationElicitations.input}->>'setup_url' = ${input.setup_url}`,
        sql`coalesce(${conversationElicitations.delivery_last_error}, '') not in ('url_credential_claimed', 'url_completed', 'url_failed')`,
      ),
    )
    .returning({ id: conversationElicitations.id });
  if (!row) return { reissued: false, reason: "no_longer_pending" };
  await deps.audit(
    {
      tenant_id: p.tenant_id,
      actor_type: p.principal.kind,
      actor_id: p.principal.id,
      action: AuditAction.CONNECTOR_CREDENTIAL_GRANT_ISSUED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      metadata: {
        draft_only: true,
        reissued: true,
        reissue_count: reissues + 1,
        auth_type: input.auth_type ?? null,
        connector_slug: input.connector_slug ?? null,
        elicitation_id: p.elicitation_id,
      },
    },
    db,
  );
  return { reissued: true, input: next, expires_at: grant.expires_at };
}
