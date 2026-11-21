import robotsParser, { type Robot } from "robots-parser";
import { getConfig } from "../config/loader.ts";
import type { Executor } from "../db/client.ts";
import { logger } from "../logging/index.ts";
import { getDriverFetch } from "./drivers/fetch-seam.ts";
import { readBodyCapped } from "./drivers/response-body.ts";
import { fetchWithEgressGuard } from "./egress-fetch.ts";

const ROBOTS_FETCH_TIMEOUT_MS = 5_000;
export const ROBOTS_MAX_BYTES = 512 * 1024;

interface Entry {
  parsed: Robot | null;
  status: "available" | "absent" | "unavailable";
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

interface RobotsLookup {
  exec: Executor;
  tenantId: string;
  origin: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
}

export interface RobotsVerification {
  parsed: Robot | null;
  status: "available" | "absent" | "unavailable";
}

export async function getRobots(params: RobotsLookup): Promise<Robot | null> {
  return (await getRobotsVerification(params)).parsed;
}

export async function getRobotsVerification(params: RobotsLookup): Promise<RobotsVerification> {
  const { tenantId, origin, userAgent } = params;
  const cfg = getConfig(tenantId).connectors.web_scraper.robots_cache;
  const now = Date.now();
  const cacheKey = key(tenantId, origin);

  evictExpired(now, cfg.ttl_ms);

  const hit = cache.get(cacheKey);
  if (hit) {
    hit.lastUsedAt = now;
    return { parsed: hit.parsed, status: hit.status };
  }

  evictLruIfFull(cfg.max_entries);

  const robotsUrl = `${origin}/robots.txt`;
  const doFetch = params.fetchImpl ?? getDriverFetch();
  let parsed: Robot | null = null;
  let status: RobotsVerification["status"] = "unavailable";
  try {
    const signal = AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS);
    const res = await fetchWithEgressGuard(
      robotsUrl,
      {
        method: "GET",
        headers: { "User-Agent": userAgent, Accept: "text/plain" },
        signal,
      },
      { tenant_id: tenantId, exec: params.exec },
      { fetchImpl: doFetch },
    );
    if (res.ok) {
      const body = await readBodyCapped(res, ROBOTS_MAX_BYTES, robotsUrl, signal);
      parsed = robotsParser(robotsUrl, body);
      status = "available";
    } else {
      void res.body?.cancel().catch(() => {});
      if (res.status === 404 || res.status === 410) status = "absent";
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
  cache.set(cacheKey, { parsed, status, fetchedAt: now, lastUsedAt: now });
  return { parsed, status };
}
