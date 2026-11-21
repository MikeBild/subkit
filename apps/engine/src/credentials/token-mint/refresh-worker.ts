import { and, eq, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { encryptSecret } from "../../crypto/index.ts";
import type { Db } from "../../db/client.ts";
import { vaultItems } from "../../db/schema/index.ts";
import { withTenantWork } from "../../execution/index.ts";
import { lockActiveTenant, SelfServiceIdentityError } from "../../identity/index.ts";
import { errorFields, logger } from "../../logging/index.ts";
import type { DecryptedCredential, TokenMintCredentialValue } from "../types.ts";
import { runTokenMintGrant } from "./client.ts";

export const TOKEN_MINT_REFRESH_LEAD_MS = 60_000;

type TokenMintCredential = DecryptedCredential & { mode: "token_mint" };

function toBuf(u: Uint8Array): Buffer {
  return Buffer.from(u);
}

function aadFor(tenant_id: string, credential_id: string): string {
  return `credential:${tenant_id}:${credential_id}`;
}

function mintConfig(decrypted: TokenMintCredential): TokenMintCredentialValue {
  return {
    shape: decrypted.shape,
    mint_endpoint: decrypted.mint_endpoint,
    credentials: decrypted.credentials,
    token_path: decrypted.token_path,
    ...(decrypted.refresh_token_path ? { refresh_token_path: decrypted.refresh_token_path } : {}),
    ...(decrypted.expires_in_path ? { expires_in_path: decrypted.expires_in_path } : {}),
    ...(decrypted.expires_at_path ? { expires_at_path: decrypted.expires_at_path } : {}),
    ...(decrypted.header_template ? { header_template: decrypted.header_template } : {}),
  };
}

export async function refreshTokenMintIfStale(
  db: Db,
  tenant_id: string,
  credRow: typeof vaultItems.$inferSelect,
  decrypted: TokenMintCredential,
): Promise<TokenMintCredential> {
  return withTenantWork(tenant_id, async () => {
    if (credRow.tenant_id !== tenant_id) throw new Error("credential_tenant_mismatch");
    const expiresAt = decrypted.expires_at ?? credRow.oauth2_expires_at ?? null;
    const expiresMs = expiresAt ? expiresAt.getTime() : 0;
    if (
      decrypted.access_token.length > 0 &&
      expiresMs > 0 &&
      expiresMs - Date.now() > TOKEN_MINT_REFRESH_LEAD_MS
    ) {
      return { ...decrypted, expires_at: expiresAt };
    }
    const config = mintConfig(decrypted);
    try {
      const bundle = await runTokenMintGrant(config, { tenant_id, exec: db });
      const enc = encryptSecret(
        JSON.stringify({ access_token: bundle.access_token, ...config }),
        aadFor(tenant_id, credRow.id),
      );
      const generation = await db.transaction(async (tx) => {
        await lockActiveTenant(tenant_id, tx);
        const [rotated] = await tx
          .update(vaultItems)
          .set({
            credential_generation: sql`${vaultItems.credential_generation} + 1`,
            verified_identity: null,
            ciphertext: toBuf(enc.ciphertext),
            iv: toBuf(enc.iv),
            auth_tag: toBuf(enc.auth_tag),
            oauth2_expires_at: bundle.expires_at,
            updated_at: new Date(),
          })
          .where(
            and(
              eq(vaultItems.tenant_id, tenant_id),
              eq(vaultItems.id, credRow.id),
              eq(vaultItems.credential_generation, credRow.credential_generation),
              isNull(vaultItems.deleted_at),
            ),
          )
          .returning({ credential_generation: vaultItems.credential_generation });
        if (!rotated)
          throw Object.assign(new Error("credential changed during refresh"), {
            code: "credential_generation_changed",
          });
        await auditAwait(
          {
            tenant_id,
            actor_type: "system",
            action: AuditAction.VAULT_ITEM_REFRESHED,
            resource_type: "vault_item",
            resource_id: credRow.id,
            result: "success",
            metadata: { connector_id: credRow.connector_id, mode: "token_mint" },
          },
          tx,
        );
        return rotated.credential_generation;
      });
      credRow.credential_generation = generation;
      credRow.verified_identity = null;
      credRow.oauth2_expires_at = bundle.expires_at;
      logger.info({
        module: "token_mint",
        action: "token_mint.refresh_success",
        credential_id: credRow.id,
        connector_id: credRow.connector_id,
      });
      return {
        ...decrypted,
        access_token: bundle.access_token,
        expires_at: bundle.expires_at,
        refresh_token: bundle.refresh_token ?? decrypted.refresh_token,
      };
    } catch (err) {
      if (
        err instanceof SelfServiceIdentityError ||
        (err as { code?: string }).code === "credential_generation_changed"
      )
        throw err;
      logger.error({
        module: "token_mint",
        action: "token_mint.refresh_failed",
        msg: "failed to re-mint token_mint credential inline",
        credential_id: credRow.id,
        connector_id: credRow.connector_id,
        ...errorFields(err),
      });
      await auditAwait(
        {
          tenant_id,
          actor_type: "system",
          action: AuditAction.VAULT_ITEM_REFRESHED,
          resource_type: "vault_item",
          resource_id: credRow.id,
          result: "error",
          reason: err instanceof Error ? err.message : String(err),
          metadata: { connector_id: credRow.connector_id, mode: "token_mint" },
        },
        db,
      );
      return decrypted;
    }
  });
}
