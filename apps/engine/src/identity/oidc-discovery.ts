// OIDC discovery helpers — pure, cacheable, Zod-validated.
//
// Wraps `openid-client.discovery` so the same insecure-HTTP allowance
// used by the rest of the engine also works for verify-only flows
// (e.g. the OIDC branch of `POST /v1/identity/sessions`). The exported functions are
// side-effect-free except for a per-process in-memory cache that is
// keyed by issuer URL. Tests can flush the cache between runs.

import * as oauth from "openid-client";
import { z } from "zod";

// Zod schema for the slice of the discovery doc the engine cares about.
export const DiscoveryDocSchema = z.object({
  issuer: z.string().min(1),
  jwks_uri: z.string().url().optional(),
});

export type DiscoveryDoc = z.infer<typeof DiscoveryDocSchema>;

// Default cache TTL: 5 minutes. Long enough to avoid hammering the IdP
// on every request, short enough to pick up key rotations quickly.
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  doc: DiscoveryDoc;
  fetchedAt: number;
}

// Module-level cache. Exposed for test flushes only — production code
// must not mutate it directly.
const cache = new Map<string, CacheEntry>();

/** Flush all cached discovery documents. Intended for test teardown. */
export function flushDiscoveryCache(): void {
  cache.clear();
}

/**
 * Return true if the cache has a live (non-expired) entry for `issuerUrl`.
 *
 * The URL is normalized (via `new URL()`) so callers can pass either the
 * exact string stored during `fetchDiscovery` or an equivalent form without
 * a trailing slash — both map to the same cache key.
 */
export function isCached(issuerUrl: string, nowMs = Date.now()): boolean {
  // Normalize to match the key format used by fetchDiscovery (URL.toString()
  // always appends a trailing slash to bare origins).
  let key: string;
  try {
    key = new URL(issuerUrl).toString();
  } catch {
    return false;
  }
  const entry = cache.get(key);
  if (!entry) return false;
  return nowMs - entry.fetchedAt < CACHE_TTL_MS;
}

/**
 * Fetch + Zod-parse the OIDC discovery document for `issuerUrl`.
 *
 * Results are cached in-process for `CACHE_TTL_MS` milliseconds.
 * `http://` issuers are accepted so mock servers used in tests work
 * without needing TLS certificates.
 *
 * @throws if the issuer is unreachable, returns a non-200 status, or
 *         the discovery document fails Zod validation.
 */
export async function fetchDiscovery(
  issuerUrl: URL,
  opts: { nowMs?: number } = {},
): Promise<DiscoveryDoc> {
  const key = issuerUrl.toString();
  const now = opts.nowMs ?? Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.doc;
  }

  const discoveryOptions: oauth.DiscoveryRequestOptions =
    issuerUrl.protocol === "http:" ? { execute: [oauth.allowInsecureRequests] } : {};

  // clientId is required by openid-client.discovery even for verify-only
  // flows where we never exchange tokens.
  const cfg = await oauth.discovery(
    issuerUrl,
    "subkit-cli",
    undefined,
    undefined,
    discoveryOptions,
  );
  const meta = cfg.serverMetadata();

  const raw = {
    issuer: meta.issuer,
    ...(meta.jwks_uri ? { jwks_uri: meta.jwks_uri } : {}),
  };

  // Zod-parse so callers can rely on the typed contract.
  const doc = DiscoveryDocSchema.parse(raw);

  cache.set(key, { doc, fetchedAt: now });
  return doc;
}
