// RFC 8693 token exchange: API key → short-lived Bearer token.
//
// `POST /v1/oauth/token` with
//   grant_type=urn:ietf:params:oauth:grant-type:token-exchange
//   subject_token=<wf_live_… api key>
//   subject_token_type=urn:subkit:params:oauth:token-type:api-key
//   [scope=<subset of the key's scopes>] [ttl=<seconds, ≤ 3600>]
// answers with a Bearer token the engine accepts everywhere the key is
// accepted — same principal, tenant, roles, scopes and allow-lists. The key
// itself then travels once per TTL instead of on every request, and never
// shows up in request logs.
//
// The token is STATELESS: an HS256 JWT signed with a MASTER_KEY-derived
// secret, bound to the key row (`api_key_id`) and to the key VERSION (a
// fingerprint of the stored hash). No table, no migration. On every use the
// provider re-reads the row and runs the exact api-key state checks
// (`providers/api-key-row.ts`), so revoking, expiring or rotating the key
// refuses its tokens at once; a rotated-in key has a new row and a new
// hash, so a token minted for the old one cannot follow it.
//
// No refresh token is issued — a machine that needs a new token has the key
// and exchanges again.

import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import * as jose from "jose";

import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { type Db, getDb } from "../../db/client.ts";
import { apiKeys } from "../../db/schema/index.ts";
import { env } from "../../env.ts";
import { log } from "../../logging/logger.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { extractBearerToken, matchApiKeyRow } from "../providers/api-key.ts";
import {
  type ApiKeyRow,
  normalizeAllowList,
  normalizeScopes,
  resolvePrincipalFromApiKeyRow,
} from "../providers/api-key-row.ts";
import type { AllowList, AuthProvider, ResolvedPrincipal } from "../types.ts";

export const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const API_KEY_TOKEN_TYPE = "urn:subkit:params:oauth:token-type:api-key";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
export const TOKEN_EXCHANGE_DEFAULT_TTL_SECONDS = 900;
export const TOKEN_EXCHANGE_MAX_TTL_SECONDS = 3600;
/** Scope entries of this form narrow `allowed_workflows` instead of `scopes`. */
export const WORKFLOW_SCOPE_PREFIX = "workflow:";

const JWT_TYP = "subkit-tx+jwt";
const JWT_ALG = "HS256";
const JWT_ISSUER = "subkit";
const PROVIDER = "token_exchange";

export class TokenExchangeError extends Error {
  readonly oauth_error: string;
  constructor(oauthError: string, description: string) {
    super(description);
    this.name = "TokenExchangeError";
    this.oauth_error = oauthError;
  }
}

/** Signing secret. Derived from MASTER_KEY so every instance sharing the
 *  key material verifies each other's tokens without shared state. */
export function deriveTokenExchangeSecret(masterKey: string = env.MASTER_KEY ?? ""): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`${masterKey}:token-exchange`).digest());
}

/** Fingerprint of the key VERSION. The stored hash changes with every
 *  rotation, so a token bound to it dies with the version it was minted for.
 *  Never the hash itself — the token is readable by whoever holds it. */
export function keyVersionFingerprint(tokenSha256: string): string {
  return createHash("sha256").update(`v1:${tokenSha256}`).digest("hex").slice(0, 32);
}

export function parseScopeParam(scope: string | undefined): string[] {
  if (!scope) return [];
  return [...new Set(scope.split(/\s+/).filter(Boolean))];
}

/** Clamp a requested lifetime to (0, 3600]. Missing → 900. */
export function resolveTtlSeconds(requested: number | string | undefined): number {
  if (requested === undefined || requested === "") return TOKEN_EXCHANGE_DEFAULT_TTL_SECONDS;
  const n = typeof requested === "number" ? requested : Number(requested);
  if (!Number.isInteger(n) || n <= 0) {
    throw new TokenExchangeError("invalid_request", "ttl must be a positive integer of seconds");
  }
  return Math.min(n, TOKEN_EXCHANGE_MAX_TTL_SECONDS);
}

export interface KeyGrants {
  scopes: string[];
  allowed_workflows?: AllowList;
}

export interface NarrowedGrants {
  scopes: string[];
  /** Present only when the request narrowed the workflows. */
  allowed_workflows?: string[];
}

function keyCoversScope(keyScopes: string[], scope: string): boolean {
  return keyScopes.includes("*") || keyScopes.includes(scope);
}

/**
 * Narrow the key's grants to what the request asked for. Plain entries must
 * be scopes the key holds (`*` on the key covers everything); `workflow:<id>`
 * entries must be workflows the key may run. Anything wider → invalid_scope.
 * An empty request inherits the key's scopes unchanged.
 */
export function narrowGrants(requested: string[], key: KeyGrants): NarrowedGrants {
  if (requested.length === 0) return { scopes: key.scopes };
  const scopes: string[] = [];
  const workflows: string[] = [];
  for (const entry of requested) {
    if (entry.startsWith(WORKFLOW_SCOPE_PREFIX)) {
      const workflowId = entry.slice(WORKFLOW_SCOPE_PREFIX.length);
      const allowed = key.allowed_workflows;
      const covered =
        workflowId.length > 0 &&
        (allowed === undefined || allowed === "all" || allowed.includes(workflowId));
      if (!covered) {
        throw new TokenExchangeError("invalid_scope", `workflow not granted to the key: ${entry}`);
      }
      workflows.push(workflowId);
      continue;
    }
    if (!keyCoversScope(key.scopes, entry)) {
      throw new TokenExchangeError("invalid_scope", `scope not granted to the key: ${entry}`);
    }
    scopes.push(entry);
  }
  return {
    scopes: scopes.length > 0 ? scopes : key.scopes,
    ...(workflows.length > 0 ? { allowed_workflows: workflows } : {}),
  };
}

export interface ExchangedTokenClaims extends jose.JWTPayload {
  tenant_id: string;
  api_key_id: string;
  key_version: string;
  scope: string;
  allowed_workflows?: string[];
}

export interface TokenExchangeRequest {
  db?: Db;
  subjectToken: string;
  subjectTokenType: string;
  scope?: string | undefined;
  ttl?: number | string | undefined;
  requestSource: RequestSource;
  /** Origin request, for failed-attempt tracking; absent on the host CLI. */
  req?: Request | null;
}

export interface TokenExchangeResponse {
  access_token: string;
  issued_token_type: typeof ACCESS_TOKEN_TYPE;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

/** Mint a short-lived token for an API key. Throws `TokenExchangeError`. */
export async function exchangeApiKeyForToken(
  input: TokenExchangeRequest,
): Promise<TokenExchangeResponse> {
  if (input.subjectTokenType !== API_KEY_TOKEN_TYPE) {
    throw new TokenExchangeError(
      "invalid_request",
      `unsupported subject_token_type; expected ${API_KEY_TOKEN_TYPE}`,
    );
  }
  const ttl = resolveTtlSeconds(input.ttl);
  const requested = parseScopeParam(input.scope);

  const db = input.db ?? getDb();
  const row = await matchApiKeyRow(db, input.subjectToken, input.req ?? null, PROVIDER);
  if (!row) throw new TokenExchangeError("invalid_grant", "api key not accepted");
  // Same state + owner checks as a direct key use — a revoked, expired or
  // rotated-out key cannot be exchanged, and a disabled owner cannot either.
  const principal = await resolvePrincipalFromApiKeyRow(db, row, { provider: PROVIDER });
  if (!principal) throw new TokenExchangeError("invalid_grant", "api key not accepted");

  const grants = narrowGrants(requested, {
    scopes: normalizeScopes(row.scopes) ?? [],
    ...(principal.allowed_workflows !== undefined
      ? { allowed_workflows: principal.allowed_workflows }
      : {}),
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims: ExchangedTokenClaims = {
    tenant_id: row.tenant_id,
    api_key_id: row.id,
    key_version: keyVersionFingerprint(row.token_sha256),
    scope: grants.scopes.join(" "),
    ...(grants.allowed_workflows ? { allowed_workflows: grants.allowed_workflows } : {}),
  };
  const accessToken = await new jose.SignJWT(claims)
    .setProtectedHeader({ alg: JWT_ALG, typ: JWT_TYP })
    .setIssuer(JWT_ISSUER)
    .setSubject(principal.id)
    .setJti(randomUUID())
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ttl)
    .sign(deriveTokenExchangeSecret());

  audit(
    {
      tenant_id: row.tenant_id,
      actor_type: principal.kind === "user" ? "user" : "system_account",
      actor_id: principal.id,
      action: AuditAction.API_KEY_TOKEN_EXCHANGED,
      resource_type: "api_key",
      resource_id: row.id,
      result: "success",
      metadata: {
        prefix: row.prefix,
        scope: claims.scope,
        ...(grants.allowed_workflows ? { allowed_workflows: grants.allowed_workflows } : {}),
        expires_in: ttl,
        request_source: input.requestSource,
      },
    },
    db,
  );

  return {
    access_token: accessToken,
    issued_token_type: ACCESS_TOKEN_TYPE,
    token_type: "Bearer",
    expires_in: ttl,
    scope: claims.scope,
  };
}

/** Cheap pre-check so foreign JWTs never reach the verifier. */
export function looksLikeExchangedToken(token: string): boolean {
  const firstDot = token.indexOf(".");
  if (firstDot <= 0 || token.indexOf(".", firstDot + 1) < 0) return false;
  try {
    const header = JSON.parse(Buffer.from(token.slice(0, firstDot), "base64url").toString());
    return header?.typ === JWT_TYP;
  } catch {
    return false;
  }
}

export async function verifyExchangedToken(token: string): Promise<ExchangedTokenClaims | null> {
  try {
    const { payload } = await jose.jwtVerify(token, deriveTokenExchangeSecret(), {
      issuer: JWT_ISSUER,
      algorithms: [JWT_ALG],
      typ: JWT_TYP,
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.tenant_id !== "string" ||
      typeof payload.api_key_id !== "string" ||
      typeof payload.key_version !== "string" ||
      typeof payload.scope !== "string"
    ) {
      return null;
    }
    return payload as ExchangedTokenClaims;
  } catch {
    return null;
  }
}

function intersectAllowList(current: AllowList | undefined, narrowed: string[]): AllowList {
  if (current === undefined || current === "all") return narrowed;
  return narrowed.filter((id) => current.includes(id));
}

/**
 * Apply the token's narrowing on top of the key's CURRENT grants. The key
 * row is authoritative — a scope removed from the key after minting is gone
 * from the token too.
 */
export function applyTokenGrants(
  principal: ResolvedPrincipal,
  claims: ExchangedTokenClaims,
  row: Pick<ApiKeyRow, "scopes">,
): ResolvedPrincipal {
  const keyScopes = normalizeScopes(row.scopes) ?? [];
  const tokenScopes = parseScopeParam(claims.scope);
  principal.scopes = tokenScopes.filter((s) => keyCoversScope(keyScopes, s));
  if (claims.allowed_workflows) {
    principal.allowed_workflows = intersectAllowList(
      normalizeAllowList(principal.allowed_workflows),
      claims.allowed_workflows,
    );
  }
  return principal;
}

export interface TokenExchangeProviderOptions {
  db?: Db;
}

/** Auth provider for exchanged tokens. Register ahead of `api_key`. */
export function createTokenExchangeProvider(opts: TokenExchangeProviderOptions = {}): AuthProvider {
  return {
    name: PROVIDER,
    capabilities: { human: false, machine: true, interactive: false, refresh: false, revoke: true },
    async resolve(req: Request): Promise<ResolvedPrincipal | null> {
      const token = extractBearerToken(req);
      if (!token || !looksLikeExchangedToken(token)) return null;
      const claims = await verifyExchangedToken(token);
      if (!claims) {
        log.auth.denied({ provider: PROVIDER, reason: "token_invalid_or_expired" });
        return null;
      }
      const db = opts.db ?? getDb();
      const rows = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, claims.api_key_id), eq(apiKeys.tenant_id, claims.tenant_id)))
        .limit(1);
      const row = rows[0];
      if (!row) {
        log.auth.denied({
          provider: PROVIDER,
          reason: "key_missing",
          api_key_id: claims.api_key_id,
        });
        return null;
      }
      if (keyVersionFingerprint(row.token_sha256) !== claims.key_version) {
        log.auth.denied({ provider: PROVIDER, reason: "key_version_mismatch", api_key_id: row.id });
        return null;
      }
      const principal = await resolvePrincipalFromApiKeyRow(db, row, {
        provider: PROVIDER,
        via: "token_exchange",
      });
      if (!principal) return null;
      if (principal.id !== claims.sub) {
        log.auth.denied({ provider: PROVIDER, reason: "owner_changed", api_key_id: row.id });
        return null;
      }
      return applyTokenGrants(principal, claims, row);
    },
  };
}
