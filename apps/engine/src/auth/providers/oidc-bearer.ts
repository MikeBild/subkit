import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import { z } from "zod";
import { getConfig, isConfigLoaded } from "../../config/loader.ts";
import type { OidcBearerProviderConfig } from "../../config/schema.ts";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { fetchDiscovery } from "../../identity/oidc-discovery.ts";
import { log } from "../../logging/logger.ts";
import {
  IdentityLinkConflictError,
  ProductIdentityErasedError,
  resolveProductBearerIdentity,
} from "../identity-link.ts";
import type { AuthDenial, DenyingAuthProvider, ResolvedPrincipal } from "../types.ts";

export const OIDC_BEARER_PROVIDER_NAME = "oidc_bearer";

const JWKS_TIMEOUT_MS = 5_000;
const JWKS_COOLDOWN_MS = 30_000;
const DISCOVERY_FAILURE_COOLDOWN_MS = 30_000;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export interface OidcBearerProviderOptions {
  db: Db;
  providers?: () => OidcBearerProviderConfig[];
  now?: () => Date;
  jwksCooldownMs?: number;
  discoveryFailureCooldownMs?: number;
}

interface JwksEntry {
  digest: string;
  getKey: JWTVerifyGetKey;
}

const jwksCache = new Map<string, JwksEntry>();
const discoveryFailures = new Map<string, { digest: string; until: number }>();

export function flushOidcBearerKeys(): void {
  jwksCache.clear();
  discoveryFailures.clear();
}

async function discoveredJwksUri(
  provider: OidcBearerProviderConfig,
  now: Date,
  failureCooldownMs: number,
): Promise<string> {
  const digest = providerDigest(provider);
  const failed = discoveryFailures.get(provider.id);
  if (failed?.digest === digest && now.getTime() < failed.until)
    throw Object.assign(new Error("issuer discovery failed recently"), {
      code: "issuer_discovery_unavailable",
    });
  try {
    const jwksUri = (await fetchDiscovery(new URL(provider.issuer_url))).jwks_uri;
    if (!jwksUri) throw new Error("issuer discovery publishes no jwks_uri");
    discoveryFailures.delete(provider.id);
    return jwksUri;
  } catch (error) {
    discoveryFailures.set(provider.id, { digest, until: now.getTime() + failureCooldownMs });
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      code: "issuer_discovery_unavailable",
    });
  }
}

function configuredBearerProviders(): OidcBearerProviderConfig[] {
  if (!isConfigLoaded()) return [];
  return getConfig().auth.providers.filter(
    (provider): provider is OidcBearerProviderConfig => provider.protocol === "oidc_bearer",
  );
}

function providerDigest(provider: OidcBearerProviderConfig): string {
  return createHash("sha256").update(JSON.stringify(provider)).digest("hex");
}

function bearerHeaderToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth || auth.length <= 7 || auth.slice(0, 7).toLowerCase() !== "bearer ") return null;
  const token = auth.slice(7).trim();
  return COMPACT_JWS.test(token) ? token : null;
}

function unverifiedIssuer(token: string): string | null {
  try {
    const iss = decodeJwt(token).iss;
    return typeof iss === "string" ? iss : null;
  } catch {
    return null;
  }
}

function unverifiedAlgorithm(token: string): string | null {
  try {
    const alg = decodeProtectedHeader(token).alg;
    return typeof alg === "string" ? alg : null;
  } catch {
    return null;
  }
}

async function keySetFor(
  provider: OidcBearerProviderConfig,
  cooldownMs: number,
  now: Date,
  failureCooldownMs: number,
): Promise<JWTVerifyGetKey> {
  const digest = `${providerDigest(provider)}:${cooldownMs}`;
  const cached = jwksCache.get(provider.id);
  if (cached?.digest === digest) return cached.getKey;
  const jwksUri = provider.jwks_uri ?? (await discoveredJwksUri(provider, now, failureCooldownMs));
  const getKey = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: JWKS_TIMEOUT_MS,
    cooldownDuration: cooldownMs,
  });
  jwksCache.set(provider.id, { digest, getKey });
  return getKey;
}

function claimAt(payload: JWTPayload, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function deny(reason: string): AuthDenial {
  log.auth.denied({ provider: OIDC_BEARER_PROVIDER_NAME, reason });
  return { denied: true, provider: OIDC_BEARER_PROVIDER_NAME, reason };
}

export function createOidcBearerProvider(opts: OidcBearerProviderOptions): DenyingAuthProvider {
  const providers = opts.providers ?? configuredBearerProviders;
  const now = opts.now ?? (() => new Date());

  function claimedProvider(req: Request): {
    token: string;
    provider: OidcBearerProviderConfig;
  } | null {
    const token = bearerHeaderToken(req);
    if (!token) return null;
    const iss = unverifiedIssuer(token);
    if (!iss) return null;
    const provider = providers().find((entry) => entry.issuer_url === iss);
    return provider ? { token, provider } : null;
  }

  return {
    name: OIDC_BEARER_PROVIDER_NAME,
    capabilities: {
      human: true,
      machine: false,
      interactive: false,
      refresh: false,
      revoke: false,
    },

    claims(req: Request): boolean {
      return claimedProvider(req) !== null;
    },

    async resolve(req: Request): Promise<ResolvedPrincipal | AuthDenial | null> {
      const claimed = claimedProvider(req);
      if (!claimed) return null;
      const { token, provider } = claimed;
      const alg = unverifiedAlgorithm(token);
      if (!alg || !(provider.algorithms as string[]).includes(alg)) {
        return deny("algorithm_not_allowed");
      }
      let payload: JWTPayload;
      try {
        const verified = await jwtVerify(
          token,
          await keySetFor(
            provider,
            opts.jwksCooldownMs ?? JWKS_COOLDOWN_MS,
            now(),
            opts.discoveryFailureCooldownMs ?? DISCOVERY_FAILURE_COOLDOWN_MS,
          ),
          {
            issuer: provider.issuer_url,
            audience: provider.audience,
            algorithms: provider.algorithms,
            clockTolerance: provider.clock_tolerance_s,
            requiredClaims: ["sub", "exp", "iat"],
            currentDate: now(),
          },
        );
        payload = verified.payload;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return deny(typeof code === "string" ? code : "token_unverifiable");
      }
      for (const claim of provider.required_claims) {
        const actual = claimAt(payload, claim.path);
        if (actual === undefined) return deny("required_claim_missing");
        if (actual !== claim.equals) return deny("required_claim_mismatch");
      }
      if (provider.reject_anonymous && payload.is_anonymous === true) {
        return deny("anonymous_subject");
      }
      const subject = z.uuid().safeParse(payload.sub);
      if (!subject.success) return deny("subject_not_uuid");
      if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
        return deny("token_times_missing");
      }

      const db = opts.db;
      // tenant-filter:exempt — bearer tokens resolve their tenant from operator configuration by slug.
      const [tenant] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, provider.tenant_slug))
        .limit(1);
      if (!tenant) return deny("tenant_unavailable");

      let identity: Awaited<ReturnType<typeof resolveProductBearerIdentity>>;
      try {
        identity = await resolveProductBearerIdentity(db, {
          tenantId: tenant.id,
          providerId: provider.id,
          issuerUrl: provider.issuer_url,
          productId: provider.product_id,
          subject: subject.data,
          issuedAt: new Date(payload.iat * 1000),
          now: now(),
        });
      } catch (error) {
        if (error instanceof ProductIdentityErasedError) return deny("identity_erased");
        if (error instanceof IdentityLinkConflictError) return deny("identity_unavailable");
        throw error;
      }
      if (!identity.role) return deny("role_unavailable");

      return {
        provider: provider.id,
        kind: "user",
        id: identity.userId,
        tenant_id: tenant.id,
        product_id: provider.product_id,
        roles: [identity.role],
        subject: subject.data,
        auth_source: {
          kind: "external_bearer",
          provider_id: provider.id,
          identity_id: identity.identityId,
          issued_at: new Date(payload.iat * 1000).toISOString(),
          expires_at: new Date(payload.exp * 1000).toISOString(),
        },
      };
    },
  };
}
