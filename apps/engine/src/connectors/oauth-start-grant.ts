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

export function generateStartGrant(): IssuedStartGrant {
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

export async function mintOAuthStartGrantUrl(
  db: Db,
  opts: {
    tenant_id: string;
    connector: Pick<
      ConnectorView,
      "id" | "slug" | "driver" | "auth_type" | "config" | "template_snapshot"
    >;
    actor_id: string | null;
    actor_type?: AuditActorType;
    ttl_ms?: number;
  },
): Promise<MintedGrant | MintGrantError> {
  const { tenant_id, connector, actor_id, ttl_ms = 600_000 } = opts;
  const actor_type = opts.actor_type ?? (actor_id ? "user" : "system");

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
