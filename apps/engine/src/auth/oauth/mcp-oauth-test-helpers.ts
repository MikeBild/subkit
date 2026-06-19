// Shared setup + helpers for the MCP OAuth HTTP route tests, split across
// mcp-oauth-{discovery,flow,scope-audit}.test.ts. Each test file owns its own
// HttpTestServer (unique label → isolated test DB) via setupMcpOauthServer().

import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { sessions } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";

// Mirrors oauth.ts deriveSessionSecret() exactly: prefer the configured
// auth.session.secret (loadConfig auto-generates one on first boot), and
// fall back to the MASTER_KEY-derived value only when no config secret
// exists. A test cookie must be signed with whatever secret the handler
// will verify with, or session resolution fails.
export function deriveTestSessionSecret(): Uint8Array {
  try {
    const fromConfig = (getConfig().auth.session.secret ?? "").trim();
    if (fromConfig.length > 0) return new TextEncoder().encode(fromConfig);
  } catch {
    /* loader not initialised */
  }
  const masterKey = process.env.MASTER_KEY ?? "";
  return new Uint8Array(createHash("sha256").update(`${masterKey}:session`).digest());
}

export async function mintSessionCookie(payload: {
  session_id: string;
  user_id: string;
  tenant_id: string;
}): Promise<string> {
  const secret = deriveTestSessionSecret();
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
}

export async function seedSession(dbArg: Db, tenantId: string, userId: string): Promise<string> {
  const [row] = await dbArg
    .insert(sessions)
    .values({
      tenant_id: tenantId,
      user_id: userId,
      expires_at: new Date(Date.now() + 3_600_000), // allow-wall-clock
      last_seen_at: new Date(), // allow-wall-clock
      absolute_expires_at: new Date(Date.now() + 86_400_000), // allow-wall-clock
    })
    .returning();
  if (!row) throw new Error("seed session failed");
  return row.id;
}

export function makeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
export const CODE_CHALLENGE = makeChallenge(CODE_VERIFIER);

// The OAuth discovery documents, the login-redirect funnel, and the
// /mcp WWW-Authenticate resource_metadata header all resolve against
// server.public_base_url. Set it explicitly so each suite is
// self-contained and does not depend on an external SK_OVERRIDE_* env.
export async function setupMcpOauthServer(
  label: string,
): Promise<{ ctx: HttpTestServer; priorBaseUrl: string }> {
  const ctx = await createHttpTestServer(label);
  const priorBaseUrl = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", "https://test.example.com", { force: true });
  return { ctx, priorBaseUrl };
}

export async function teardownMcpOauthServer(
  ctx: HttpTestServer,
  priorBaseUrl: string,
): Promise<void> {
  await setConfigKey("server.public_base_url", priorBaseUrl, { force: true });
  await ctx.cleanup();
}
