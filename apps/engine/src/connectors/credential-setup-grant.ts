// Single-use credential-setup grant — browser-openable short-lived tokens
// for non-OAuth (bearer / basic / header / query) connectors.
//
// Discipline mirrors oauth-start-grant.ts:
//   - 24 random bytes → url-safe base64, `sksg_` prefix for redaction
//     recognizability. ("sksg" = sk Setup Grant)
//   - SHA-256 hex stored at rest; plaintext returned once at mint time.
//   - 10-min TTL.
//
// CRITICAL DIFFERENCE from consumeStartGrant: a credential-setup flow is
// TWO hits — GET renders the form, POST submits it. If the GET consumed
// the grant, the token would be dead before the user could submit the
// form. So this module exposes THREE functions instead of one:
//   - mintCredentialSetupGrantUrl — insert row, return tokenized URL.
//   - validateSetupGrant          — SELECT only, no delete. Used by the
//                                    GET route to render the form.
//   - consumeSetupGrant           — atomic DELETE … RETURNING, bound to
//                                    connector_id. Used by the POST route
//                                    immediately before writing the
//                                    credential.
//
// This is also why credential-setup grants live in their OWN table
// (connector_credential_setup_grants) rather than reusing
// connector_oauth_start_grants: that table's contract is consume-on-
// first-touch, and reusing it would let a leaked OAuth grant redeem at
// the credential-setup route.
//
// Typed errors (never thrown — returned as discriminated union):
//   - "engine_public_url_missing": buildOAuthRedirectUri() returned null.
//
// NEVER log the plaintext token — only its sha256 hash or a redacted
// prefix belong in logs/audit metadata.

import { randomBytes } from "node:crypto";

import { and, eq, gt, sql } from "drizzle-orm";

import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { buildOAuthRedirectUri, OAUTH_CALLBACK_PATH } from "../credentials/oauth2/redirect-uri.ts";
import type { Db } from "../db/client.ts";
import { connectorCredentialSetupGrants } from "../db/schema/index.ts";
import { now } from "../utils/clock.ts";
// Reuse the shared sha256Hex helper from the OAuth start-grant module rather
// than redefining/re-exporting it here — both modules apply the identical
// portal-token discipline (hash-at-rest, plaintext-once), and re-exporting a
// second `sha256Hex` from this module would collide in the connectors barrel
// (connectors/index.ts re-exports both modules via `export *`). Callers that
// need to hash a plaintext grant token (e.g. tests) import `sha256Hex` from
// `./oauth-start-grant.ts`.
import { sha256Hex } from "./oauth-start-grant.ts";
import type { ConnectorView } from "./types.ts";

export const CREDENTIAL_SETUP_GRANT_PREFIX = "sksg_";

export interface IssuedCredentialSetupGrant {
  plaintext: string;
  hash: string;
}

/** Generate a fresh opaque credential-setup grant token. Hash is SHA-256 hex. */
export function generateCredentialSetupGrant(): IssuedCredentialSetupGrant {
  // 24 random bytes → 32 url-safe chars + sksg_ prefix.
  const rand = randomBytes(24).toString("base64url");
  const plaintext = `${CREDENTIAL_SETUP_GRANT_PREFIX}${rand}`;
  return { plaintext, hash: sha256Hex(plaintext) };
}

export type MintCredentialSetupGrantError = { ok: false; error: "engine_public_url_missing" };

export interface MintedCredentialSetupGrant {
  ok: true;
  url: string;
  expires_at: Date;
}

/**
 * Mint a single-use credential-setup grant URL for a non-OAuth connector.
 *
 * Returns a typed error rather than throwing for the expected failure mode
 * (missing public origin). Unexpected errors propagate.
 *
 * Audits CONNECTOR_CREDENTIAL_GRANT_ISSUED on success.
 */
export async function mintCredentialSetupGrantUrl(
  db: Db,
  opts: {
    tenant_id: string;
    connector: Pick<ConnectorView, "id" | "slug" | "auth_type">;
    actor_id: string | null;
    /** Audit attribution for the minting principal. A system_account
     *  driving a conversation must not be recorded as "user". */
    actor_type?: AuditActorType;
    ttl_ms?: number;
  },
): Promise<MintedCredentialSetupGrant | MintCredentialSetupGrantError> {
  const { tenant_id, connector, actor_id, ttl_ms = 600_000 } = opts;
  const actor_type = opts.actor_type ?? (actor_id ? "user" : "system");

  const redirect_uri = buildOAuthRedirectUri();
  if (!redirect_uri) {
    return { ok: false, error: "engine_public_url_missing" };
  }
  const origin = redirect_uri.slice(0, -OAUTH_CALLBACK_PATH.length);

  const { plaintext, hash } = generateCredentialSetupGrant();
  const expires_at = new Date(now() + ttl_ms);

  await db.insert(connectorCredentialSetupGrants).values({
    tenant_id,
    connector_id: connector.id,
    token_sha256: hash,
    created_by_actor_id: actor_id,
    expires_at,
  });

  await auditAwait(
    {
      tenant_id,
      actor_type,
      actor_id,
      action: AuditAction.CONNECTOR_CREDENTIAL_GRANT_ISSUED,
      resource_type: "connector",
      resource_id: connector.id,
      result: "success",
      metadata: { connector_id: connector.id, connector_slug: connector.slug },
    },
    db,
  );

  const url = `${origin}/v1/connectors/${connector.id}/credentials/setup?grant=${encodeURIComponent(plaintext)}`;
  return { ok: true, url, expires_at };
}

export interface ValidatedCredentialSetupGrant {
  id: string;
  tenant_id: string;
  connector_id: string;
  created_by_actor_id: string | null;
}

/**
 * Validate a credential-setup grant WITHOUT consuming it — a plain SELECT.
 *
 * Used by the GET route to decide whether to render the setup form. Must
 * NOT delete the row: the form still needs to be submitted, which happens
 * via consumeSetupGrant on POST.
 *
 * Returns the matching row, or `null` when the token is invalid, expired,
 * or the connector_id doesn't match the URL path.
 */
export async function validateSetupGrant(
  db: Db,
  opts: { token: string; connector_id: string },
): Promise<ValidatedCredentialSetupGrant | null> {
  const hash = sha256Hex(opts.token);
  // tenant-filter:exempt — this is the browser-facing unauthenticated route.
  // The tenant is derived from the matched row ONLY.
  const rows = await db
    .select()
    .from(connectorCredentialSetupGrants)
    .where(
      and(
        eq(connectorCredentialSetupGrants.token_sha256, hash),
        eq(connectorCredentialSetupGrants.connector_id, opts.connector_id),
        gt(connectorCredentialSetupGrants.expires_at, sql`now()`),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    connector_id: row.connector_id,
    created_by_actor_id: row.created_by_actor_id ?? null,
  };
}

export interface ConsumedCredentialSetupGrant {
  id: string;
  tenant_id: string;
  connector_id: string;
  created_by_actor_id: string | null;
}

/**
 * Atomically consume a credential-setup grant.
 *
 * Uses DELETE … RETURNING so the claim is TOCTOU-safe. The path-id guard
 * (`connector_id = :pathId`) means a leaked token can only be consumed via
 * the correct connector URL — it does NOT burn the grant on a wrong-id
 * attempt.
 *
 * Returns the consumed row on success, or `null` when the token is
 * invalid, expired, already consumed (replay), or the connector_id
 * doesn't match the URL path.
 *
 * Audits CONNECTOR_CREDENTIAL_GRANT_CONSUMED on success.
 */
export async function consumeSetupGrant(
  db: Db,
  opts: { token: string; connector_id: string },
): Promise<ConsumedCredentialSetupGrant | null> {
  const hash = sha256Hex(opts.token);
  // tenant-filter:exempt — this is the browser-facing unauthenticated route.
  // The tenant is derived from the claimed row ONLY.
  const claimed = await db
    .delete(connectorCredentialSetupGrants)
    .where(
      and(
        eq(connectorCredentialSetupGrants.token_sha256, hash),
        eq(connectorCredentialSetupGrants.connector_id, opts.connector_id),
        gt(connectorCredentialSetupGrants.expires_at, sql`now()`),
      ),
    )
    .returning();
  const row = claimed[0];
  if (!row) return null;

  await auditAwait(
    {
      tenant_id: row.tenant_id,
      // The consumer is an unauthenticated browser — the grant token IS the
      // auth. Attribution to the minting principal lives in metadata (and
      // on the paired GRANT_ISSUED row); recording it as the acting
      // principal here would claim a user performed a request they never
      // made.
      actor_type: "system",
      actor_id: null,
      action: AuditAction.CONNECTOR_CREDENTIAL_GRANT_CONSUMED,
      resource_type: "connector",
      resource_id: row.connector_id,
      result: "success",
      metadata: { connector_id: row.connector_id, created_by_actor_id: row.created_by_actor_id },
    },
    db,
  );

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    connector_id: row.connector_id,
    created_by_actor_id: row.created_by_actor_id ?? null,
  };
}
