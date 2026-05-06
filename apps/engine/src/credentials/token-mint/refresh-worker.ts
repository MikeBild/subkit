// Token-mint refresh worker (A4). Mirrors the oauth2 refresh-worker
// shape: pre-flight inline refresh, called from the HTTP driver right
// before a request goes out.
//
// Strategy: re-mint via the same `runTokenMintGrant` path as the
// initial mint. We don't track refresh-token-grant separately because
// Firebase / Cognito / generic POST /login all support running the
// USER_PASSWORD_AUTH path on every refresh — it is the simpler, more
// general fallback than provider-specific REFRESH_TOKEN_AUTH wiring.

import { eq } from "drizzle-orm";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { encryptSecret } from "../../crypto/aes-gcm.ts";
import type { Db } from "../../db/client.ts";
import { credentials } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import type { DecryptedCredential } from "../types.ts";
import { runTokenMintGrant } from "./client.ts";

const REFRESH_LEAD_MS = 60_000;

function toBuf(u: Uint8Array): Buffer {
  return Buffer.from(u);
}

function aadFor(tenant_id: string, credential_id: string): string {
  return `credential:${tenant_id}:${credential_id}`;
}

export async function refreshTokenMintIfStale(
  db: Db,
  tenant_id: string,
  credRow: typeof credentials.$inferSelect,
  decrypted: DecryptedCredential & { mode: "token_mint" },
): Promise<DecryptedCredential & { mode: "token_mint" }> {
  const now = Date.now();
  const expiresMs = decrypted.expires_at ? decrypted.expires_at.getTime() : 0;
  // Token has an explicit expiry and is still safely in-window — return
  // unchanged. When the IdP doesn't return an expiry path, expiresMs is
  // 0 and we re-mint on every request (operator opted into that by
  // omitting `expires_in_path` / `expires_at_path` from the credential).
  if (expiresMs > 0 && expiresMs - now > REFRESH_LEAD_MS) return decrypted;
  try {
    const bundle = await runTokenMintGrant({
      shape: decrypted.shape,
      mint_endpoint: decrypted.mint_endpoint,
      credentials: decrypted.credentials,
      token_path: decrypted.token_path,
      ...(decrypted.refresh_token_path ? { refresh_token_path: decrypted.refresh_token_path } : {}),
      ...(decrypted.expires_in_path ? { expires_in_path: decrypted.expires_in_path } : {}),
      ...(decrypted.expires_at_path ? { expires_at_path: decrypted.expires_at_path } : {}),
      ...(decrypted.header_template ? { header_template: decrypted.header_template } : {}),
    });
    // Persist the refreshed access token and expiry. The static mint
    // config (shape, mint_endpoint, credentials, paths, header_template)
    // is unchanged — re-encrypt the same payload with the rotated
    // access_token.
    const plaintext = JSON.stringify({
      access_token: bundle.access_token,
      shape: decrypted.shape,
      mint_endpoint: decrypted.mint_endpoint,
      credentials: decrypted.credentials,
      token_path: decrypted.token_path,
      ...(decrypted.refresh_token_path ? { refresh_token_path: decrypted.refresh_token_path } : {}),
      ...(decrypted.expires_in_path ? { expires_in_path: decrypted.expires_in_path } : {}),
      ...(decrypted.expires_at_path ? { expires_at_path: decrypted.expires_at_path } : {}),
      ...(decrypted.header_template ? { header_template: decrypted.header_template } : {}),
    });
    const enc = encryptSecret(plaintext, aadFor(tenant_id, credRow.id));
    await db
      .update(credentials)
      .set({
        ciphertext: toBuf(enc.ciphertext),
        iv: toBuf(enc.iv),
        auth_tag: toBuf(enc.auth_tag),
        oauth2_expires_at: bundle.expires_at,
        updated_at: new Date(),
      })
      .where(eq(credentials.id, credRow.id));
    audit(
      {
        tenant_id,
        actor_type: "system",
        action: AuditAction.CREDENTIAL_OAUTH2_REFRESHED,
        resource_type: "credential",
        resource_id: credRow.id,
        result: "success",
        metadata: { connector_id: credRow.connector_id, mode: "token_mint" },
      },
      db,
    );
    return {
      ...decrypted,
      access_token: bundle.access_token,
      expires_at: bundle.expires_at,
      refresh_token: bundle.refresh_token ?? decrypted.refresh_token,
    };
  } catch (err) {
    logger.error({
      module: "token_mint",
      action: "token_mint.refresh_failed",
      msg: "failed to re-mint token_mint credential inline",
      credential_id: credRow.id,
      connector_id: credRow.connector_id,
      error: err instanceof Error ? err.message : String(err),
    });
    audit(
      {
        tenant_id,
        actor_type: "system",
        action: AuditAction.CREDENTIAL_OAUTH2_REFRESHED,
        resource_type: "credential",
        resource_id: credRow.id,
        result: "error",
        reason: err instanceof Error ? err.message : String(err),
        metadata: { connector_id: credRow.connector_id, mode: "token_mint" },
      },
      db,
    );
    return decrypted;
  }
}
