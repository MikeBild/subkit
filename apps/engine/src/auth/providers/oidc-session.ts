import { createHash } from "node:crypto";
import * as jose from "jose";
import { getConfig } from "../../config/loader.ts";
import { SESSION_ABSOLUTE_TTL_MS } from "../browser-session.ts";

export const SESSION_COOKIE = "subkit_session";
const JWS_ALG = "HS256";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deriveSessionSecret(override?: Uint8Array): Uint8Array {
  if (override) return override;
  let fromConfig = "";
  try {
    fromConfig = (getConfig().auth.session.secret ?? "").trim();
  } catch {}
  if (fromConfig.length > 0) {
    return new TextEncoder().encode(fromConfig);
  }
  const masterKey = process.env.MASTER_KEY ?? "";
  return new Uint8Array(createHash("sha256").update(`${masterKey}:session`).digest());
}

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export async function signSessionCookie(
  secret: Uint8Array,
  payload: { session_id: string; user_id: string; tenant_id: string },
): Promise<string> {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: JWS_ALG })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + SESSION_ABSOLUTE_TTL_MS) / 1000))
    .sign(secret);
}

export async function verifySessionCookie(
  secret: Uint8Array,
  jwt: string,
): Promise<{ session_id: string; user_id: string; tenant_id: string } | null> {
  try {
    const { payload } = await jose.jwtVerify(jwt, secret);
    const session_id = typeof payload.session_id === "string" ? payload.session_id : null;
    const user_id = typeof payload.user_id === "string" ? payload.user_id : null;
    const tenant_id = typeof payload.tenant_id === "string" ? payload.tenant_id : null;
    if (!session_id || !user_id || !tenant_id) return null;
    return { session_id, user_id, tenant_id };
  } catch {
    return null;
  }
}

export function buildCookieHeader(jwt: string): string {
  const maxAge = Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000);
  const secure = process.env.NODE_ENV !== "development" ? " Secure;" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(
    jwt,
  )}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${maxAge}`;
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
