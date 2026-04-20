// Mints a short-lived JWT for DM-based platform identity binding.

import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import type { Db } from "../db/client.ts";
import { chatLinkTokens } from "../db/schema/index.ts";

/**
 * Thrown by {@link consumeLinkToken} when two concurrent consume attempts
 * race and only the first is allowed to land. Callers can catch this to
 * surface a stable "already consumed" signal back to the chat adapter.
 */
export class ChatLinkAlreadyConsumedError extends Error {
  constructor() {
    super("chat_link_already_consumed");
    this.name = "ChatLinkAlreadyConsumedError";
  }
}

const JWT_ALG = "HS256";
const DEFAULT_TTL_SECONDS = 15 * 60;

function secretKey(masterKey: string): Uint8Array {
  return Buffer.from(masterKey.slice(0, 64), "hex");
}

export interface LinkTokenClaims {
  tenant_id: string;
  user_id: string;
  platform: string;
  workspace_id: string;
  jti: string;
}

export async function createLinkToken(
  p: {
    tenant_id: string;
    user_id: string;
    platform: string;
    workspace_id: string;
    master_key: string;
    ttl_seconds?: number;
  },
  exec: Db,
): Promise<{ token: string; expires_at: Date }> {
  const jti = crypto.randomUUID();
  const ttl = p.ttl_seconds ?? DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const jwt = await new SignJWT({
    tenant_id: p.tenant_id,
    user_id: p.user_id,
    platform: p.platform,
    workspace_id: p.workspace_id,
  })
    .setProtectedHeader({ alg: JWT_ALG })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretKey(p.master_key));

  await exec.insert(chatLinkTokens).values({
    tenant_id: p.tenant_id,
    user_id: p.user_id,
    platform: p.platform,
    workspace_id: p.workspace_id,
    token: jti,
    expires_at: expiresAt,
  });

  return { token: jwt, expires_at: expiresAt };
}

export async function consumeLinkToken(
  p: { token: string; master_key: string },
  exec: Db,
): Promise<LinkTokenClaims | null> {
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(p.token, secretKey(p.master_key));
    payload = result.payload as Record<string, unknown>;
  } catch {
    return null;
  }
  const jti = typeof payload.jti === "string" ? payload.jti : null;
  if (!jti) return null;

  // Concurrency-safe single-use consume. We wrap the read + flip in a
  // transaction and lock the row with `SELECT ... FOR UPDATE`, so two
  // parallel attempts serialise on the row and only the first lands a
  // `consumed_at` write. The second attempt sees `consumed_at IS NOT
  // NULL` after the lock is granted and raises
  // {@link ChatLinkAlreadyConsumedError}. Expired rows resolve to `null`
  // so callers can distinguish "rejected replay" from "token too old".
  return await exec.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(chatLinkTokens)
      .where(eq(chatLinkTokens.token, jti))
      .limit(1)
      .for("update");
    const row = locked[0];
    if (!row) return null;
    if (row.consumed_at !== null) {
      throw new ChatLinkAlreadyConsumedError();
    }
    if (row.expires_at.getTime() <= Date.now()) {
      return null;
    }
    await tx
      .update(chatLinkTokens)
      .set({ consumed_at: new Date() })
      .where(eq(chatLinkTokens.id, row.id));
    return {
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      platform: row.platform,
      workspace_id: row.workspace_id,
      jti,
    };
  });
}
