// Single-use OAuth2 start grant — browser-openable short-lived tokens.
//
// The link opens the connector's OWN sign-in route — whichever
// `connectorSignIn` names: `/oauth/start` for a web service,
// `/mcp/authorize` for an MCP server. Both GET doors consume the grant the
// same way (`consumeStartGrant`).
//
// Discipline mirrors apps/engine/src/identity/portal-token.ts:
//   - 24 random bytes → url-safe base64, `skog_` prefix for redaction
//     recognizability. ("skog" = sk OAuth Grant)
//   - SHA-256 hex stored at rest; plaintext returned once at mint time.
//   - Atomic claim: DELETE … WHERE token_sha256 = sha256(token)
//     AND connector_id = :pathId AND expires_at > now() RETURNING *
//     — a wrong connector_id does NOT burn the grant.
//
// Typed errors (never thrown — returned as discriminated union):
//   - "engine_public_url_missing": buildOAuthRedirectUri() returned null.
//   - "no_browser_flow": the connector has no browser sign-in
//     (`connectorSignIn` is null), or its grant is client_credentials_json,
//     which completes without a browser — use beginConnectorOAuthDance directly.

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { buildOAuthRedirectUri, OAUTH_CALLBACK_PATH } from "../credentials/oauth2/redirect-uri.ts";
import type { Db } from "../db/client.ts";
import { connectorOauthStartGrants } from "../db/schema/index.ts";
import { now } from "../utils/clock.ts";
import { connectorSignIn } from "./sign-in.ts";
import { connectorOAuthGrantType } from "./template-binding.ts";
import type { ConnectorView } from "./types.ts";

export const GRANT_PREFIX = "skog_";

export interface IssuedStartGrant {
  plaintext: string;
  hash: string;
}

/** Generate a fresh opaque start grant token. Hash is SHA-256 hex. */
export function generateStartGrant(): IssuedStartGrant {
  // 24 random bytes → 32 url-safe chars + skog_ prefix.
  const rand = randomBytes(24).toString("base64url");
  const plaintext = `${GRANT_PREFIX}${rand}`;
  return { plaintext, hash: sha256Hex(plaintext) };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type MintGrantError =
  | { ok: false; error: "engine_public_url_missing" }
  | { ok: false; error: "no_browser_flow" };

export interface MintedGrant {
  ok: true;
  url: string;
  expires_at: Date;
}

/**
 * Mint a single-use grant URL that opens the connector's own sign-in route.
 *
 * Returns a typed error rather than throwing for the two expected failure
 * modes (missing origin, wrong grant_type). Unexpected errors propagate.
 *
 * Audits CONNECTOR_OAUTH_GRANT_ISSUED on success.
 */
export async function mintOAuthStartGrantUrl(
  db: Db,
  opts: {
    tenant_id: string;
    connector: Pick<
      ConnectorView,
      "id" | "slug" | "driver" | "auth_type" | "config" | "template_snapshot"
    >;
    actor_id: string | null;
    /** Audit attribution for the minting principal. A system_account
     *  driving a conversation must not be recorded as "user". */
    actor_type?: AuditActorType;
    ttl_ms?: number;
  },
): Promise<MintedGrant | MintGrantError> {
  const { tenant_id, connector, actor_id, ttl_ms = 600_000 } = opts;
  const actor_type = opts.actor_type ?? (actor_id ? "user" : "system");

  // The link goes where the connector's `sign_in` says. None, or a grant
  // that completes machine to machine, leaves nothing for a browser to open.
  const signIn = connectorSignIn(connector);
  if (!signIn || connectorOAuthGrantType(connector) === "client_credentials_json") {
    return { ok: false, error: "no_browser_flow" };
  }

  const redirect_uri = buildOAuthRedirectUri();
  if (!redirect_uri) {
    return { ok: false, error: "engine_public_url_missing" };
  }
  const origin = redirect_uri.slice(0, -OAUTH_CALLBACK_PATH.length);

  const { plaintext, hash } = generateStartGrant();
  const expires_at = new Date(now() + ttl_ms);

  await db.insert(connectorOauthStartGrants).values({
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
      action: AuditAction.CONNECTOR_OAUTH_GRANT_ISSUED,
      resource_type: "connector",
      resource_id: connector.id,
      result: "success",
      metadata: { connector_id: connector.id, connector_slug: connector.slug },
    },
    db,
  );

  const url = `${origin}${signIn.start}?grant=${encodeURIComponent(plaintext)}`;
  return { ok: true, url, expires_at };
}

export interface ConsumedGrant {
  id: string;
  tenant_id: string;
  connector_id: string;
  created_by_actor_id: string | null;
}

/**
 * Atomically consume a start grant.
 *
 * Uses DELETE … RETURNING so the claim is TOCTOU-safe. The path-id guard
 * (`connector_id = :pathId`) means a leaked token can only be consumed
 * via the correct connector URL — it does NOT burn the grant on a wrong-id
 * attempt.
 *
 * Returns the consumed row on success, or `null` when the token is
 * invalid, expired, or the connector_id doesn't match the URL path.
 */
export async function consumeStartGrant(
  db: Db,
  opts: { token: string; connector_id: string },
): Promise<ConsumedGrant | null> {
  const hash = sha256Hex(opts.token);
  // tenant-filter:exempt — this is the browser-facing unauthenticated route.
  // The tenant is derived from the claimed row ONLY.
  const claimed = await db
    .delete(connectorOauthStartGrants)
    .where(
      and(
        eq(connectorOauthStartGrants.token_sha256, hash),
        eq(connectorOauthStartGrants.connector_id, opts.connector_id),
        gt(connectorOauthStartGrants.expires_at, sql`now()`),
      ),
    )
    .returning();
  const row = claimed[0];
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    connector_id: row.connector_id,
    created_by_actor_id: row.created_by_actor_id ?? null,
  };
}
