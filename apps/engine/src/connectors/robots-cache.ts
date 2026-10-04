import robotsParser, { type Robot } from "robots-parser";

import { getConfig } from "../config/loader.ts";
import { logger } from "../logging/logger.ts";
import { getDriverFetch } from "./drivers/fetch-seam.ts";
import { assertEgressAllowed, EgressBlockedError } from "./egress-guard.ts";

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
  }
  cache.set(cacheKey, { parsed, fetchedAt: now, lastUsedAt: now });
  return parsed;
}
