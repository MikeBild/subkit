import { randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { resolveActor } from "../audit/recorders/types.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { buildOAuthRedirectUri, OAUTH_CALLBACK_PATH } from "../credentials/oauth2/redirect-uri.ts";
import type { Db } from "../db/client.ts";
import { connectorCredentialSetupGrants } from "../db/schema/index.ts";
import { now } from "../utils/clock.ts";
import { sha256Hex } from "./oauth-start-grant.ts";
import type { ConnectorView } from "./types.ts";

export const CREDENTIAL_SETUP_GRANT_PREFIX = "sksg_";

interface IssuedCredentialSetupGrant {
  plaintext: string;
  hash: string;
}

export function generateCredentialSetupGrant(): IssuedCredentialSetupGrant {
  const rand = randomBytes(24).toString("base64url");
  const plaintext = `${CREDENTIAL_SETUP_GRANT_PREFIX}${rand}`;
  return { plaintext, hash: sha256Hex(plaintext) };
}

type MintCredentialSetupGrantError = { ok: false; error: "engine_public_url_missing" };

interface MintedCredentialSetupGrant {
  ok: true;
  url: string;
  expires_at: Date;
}

export async function mintCredentialSetupGrantUrl(
  db: Db,
  opts: {
    tenant_id: string;
    connector: Pick<ConnectorView, "id" | "slug" | "auth_type">;
    actor_id: string | null;
    actor_type?: AuditActorType;
    ttl_ms?: number;
  },
): Promise<MintedCredentialSetupGrant | MintCredentialSetupGrantError> {
  const { tenant_id, connector, actor_id, ttl_ms = 600_000 } = opts;
  const actor = resolveActor(opts);

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
      ...actor,
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

interface ValidatedCredentialSetupGrant {
  id: string;
  tenant_id: string;
  connector_id: string;
  created_by_actor_id: string | null;
}

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

interface ConsumedCredentialSetupGrant {
  id: string;
  tenant_id: string;
  connector_id: string;
  created_by_actor_id: string | null;
}

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
