import * as oauth from "openid-client";
import { z } from "zod";

export const DiscoveryDocSchema = z.object({
  issuer: z.string().min(1),
  jwks_uri: z.string().url().optional(),
});

export type DiscoveryDoc = z.infer<typeof DiscoveryDocSchema>;

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  doc: DiscoveryDoc;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

export function flushDiscoveryCache(): void {
  cache.clear();
}

export function isCached(issuerUrl: string, nowMs = Date.now()): boolean {
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

  const doc = DiscoveryDocSchema.parse(raw);

  cache.set(key, { doc, fetchedAt: now });
  return doc;
}
