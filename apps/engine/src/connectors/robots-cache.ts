// Per-tenant robots.txt cache with bounded size + TTL (#144).
//
// Module-level Map keyed by `${tenant_id}::${origin}`. Each entry holds:
//   - parsed: result of `robots-parser(robotsTxt, robotsUrl)` (or null
//             when the fetch returned non-2xx)
//   - fetchedAt: ms-since-epoch for TTL eviction
//   - lastUsedAt: ms-since-epoch for LRU eviction at cache pressure
//
// The cache is intentionally process-local. Two reasons:
//   1. robots.txt is small (<1 MB) and per-origin churn is low; the LRU
//      bound + TTL prevent unbounded growth in any realistic workload.
//   2. We do NOT want to take a DB round-trip per outbound fetch.
//
// Tenant isolation: every cache key contains tenant_id, so tenant A's
// override of `respect_robots: false` (or a different UA) never poisons
// tenant B's verdict.
//
// Tunables (`config.connectors.web_scraper.robots_cache.*` — global):
//   - ttl_ms      (default 1h)
//   - max_entries (default 2 000)

import robotsParser, { type Robot } from "robots-parser";

import { getConfig } from "../config/loader.ts";
import { logger } from "../logging/logger.ts";
import { getDriverFetch } from "./drivers/fetch-seam.ts";
import { assertEgressAllowed, EgressBlockedError } from "./egress-guard.ts";

/** Hard cap on `robots.txt` fetches so a slow-loris origin can't stall
 *  the calling chat tool / workflow indefinitely. The cache stores the
 *  resulting `null` (treated as "allow everything") so subsequent calls
 *  for the same origin return immediately. */
const ROBOTS_FETCH_TIMEOUT_MS = 5_000;

interface Entry {
  parsed: Robot | null;
  fetchedAt: number;
  lastUsedAt: number;
}

const cache = new Map<string, Entry>();

function key(tenantId: string, origin: string): string {
  return `${tenantId}::${origin}`;
}

/** Single internal accessor for the LRU. Consumed ONLY by the sibling
 *  `robots-cache.test-helpers.ts`; production code MUST go through the
 *  public `getRobots` API. The underscore prefix + the dedicated
 *  sibling module make the test-only surface tree-shakable from the
 *  production bundle (bundlerVisitor drops modules whose only
 *  importers live under `*.test.ts` / `*.test-helpers.ts`). */
export function _internalRobotsCacheRef(): Map<string, Entry> {
  return cache;
}

function evictExpired(now: number, ttlMs: number): void {
  for (const [k, entry] of cache) {
    if (now - entry.fetchedAt > ttlMs) cache.delete(k);
  }
}

function evictLruIfFull(maxEntries: number): void {
  if (cache.size < maxEntries) return;
  // Drop the single oldest-by-lastUsedAt entry. Linear scan is fine
  // at our bounded sizes (max ~50k).
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [k, entry] of cache) {
    if (entry.lastUsedAt < oldestTs) {
      oldestTs = entry.lastUsedAt;
      oldestKey = k;
    }
  }
  if (oldestKey !== null) cache.delete(oldestKey);
}

/** Fetch (and parse) the robots.txt for the given origin, caching the
 *  result per tenant. Returns the parser, or `null` when the origin
 *  served no robots.txt (any non-2xx is treated as "allow everything"
 *  per RFC 9309 §2.3.1).
 *
 *  `fetchImpl` is injected for testability — production callers leave
 *  it undefined to use `globalThis.fetch`. */
export async function getRobots(params: {
  tenantId: string;
  origin: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
}): Promise<Robot | null> {
  const { tenantId, origin, userAgent } = params;
  const cfg = getConfig(tenantId).connectors.web_scraper.robots_cache;
  const now = Date.now();
  const cacheKey = key(tenantId, origin);

  evictExpired(now, cfg.ttl_ms);

  const hit = cache.get(cacheKey);
  if (hit) {
    hit.lastUsedAt = now;
    return hit.parsed;
  }

  evictLruIfFull(cfg.max_entries);

  const robotsUrl = `${origin}/robots.txt`;
  // SSRF guard — runs BEFORE the fetch so a tenant-supplied origin
  // can't probe internal services (AWS metadata, localhost, RFC 1918)
  // via the robots-cache pathway. The guard throws synchronously; we
  // surface it as a cache miss + null verdict (allow-all) so the
  // caller's overall behaviour is the same as "origin served no
  // robots.txt".
  try {
    assertEgressAllowed(new URL(robotsUrl), { tenant_id: tenantId });
  } catch (e) {
    if (e instanceof EgressBlockedError) {
      logger.warn({
        module: "robots_cache",
        action: "egress_blocked",
        tenant_id: tenantId,
        origin,
        reason: e.reason,
      });
      cache.set(cacheKey, { parsed: null, fetchedAt: now, lastUsedAt: now });
      return null;
    }
    throw e;
  }
  const doFetch = params.fetchImpl ?? getDriverFetch();
  let parsed: Robot | null = null;
  try {
    const res = await doFetch(robotsUrl, {
      method: "GET",
      headers: { "User-Agent": userAgent, Accept: "text/plain" },
      signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = await res.text();
      parsed = robotsParser(robotsUrl, body);
    }
  } catch (e) {
    logger.warn({
      module: "robots_cache",
      action: "fetch_failed",
      tenant_id: tenantId,
      origin,
      reason: e instanceof Error ? e.message : String(e),
    });
    // Per RFC 9309 §2.3.1, network errors and 5xx responses are treated
    // as "unavailable" → "disallow all" by strict crawlers. We instead
    // cache `null` (treated as "allow everything") because subkit's
    // tenant-scoped `respect_robots` flag is already the opt-out; a
    // missing robots.txt should not silently brick a workflow. The
    // operator who wants strict-mode behaviour can set
    // `respect_robots: false` on the connector or run with a
    // dedicated probe step first.
  }
  cache.set(cacheKey, { parsed, fetchedAt: now, lastUsedAt: now });
  return parsed;
}
