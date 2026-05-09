// What's-new resolver for the welcome banner. Fetches a one-line headline
// from a remote JSON endpoint with a 24h on-disk cache; on network
// failure falls back to (a) the last-good cached value if it exists,
// then (b) the head of the bundled CHANGELOG.md. Async — never blocks
// first paint.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Build-time embed of the repo's CHANGELOG.md. Bun's text-import bundles
// the file into the compiled binary, so this works both at dev time and
// in the shipped binary (where the source CHANGELOG isn't on disk).
import bundledChangelog from "../../../../../CHANGELOG.md" with { type: "text" };
import { configDir } from "../../config.ts";

const DEFAULT_URL = "https://updates.subkit.dev/whats-new.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

export interface WhatsNewCache {
  headline: string;
  fetchedAt: number;
}

/**
 * Extract a single-line "what's new" headline from a CHANGELOG.md body.
 * Picks the latest version header line (`## [x.y.z] ...` or
 * `## [x.y.z] (unreleased)`) so the operator sees which release line
 * they're tracking. Returns null when no version header is present.
 */
export function changelogHead(body: string = bundledChangelog): string | null {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("## ")) continue;
    const m = line.match(/^##\s+\[([^\]]+)\]\s*(.*)$/);
    if (!m) continue;
    const version = m[1];
    const tail = (m[2] ?? "").trim();
    if (!version) continue;
    return tail ? `v${version} ${tail}` : `v${version}`;
  }
  return null;
}

export interface WhatsNewRemote {
  headline: string;
}

export function whatsNewUrl(): string {
  const fromEnv = process.env.SK_WHATS_NEW_URL;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_URL;
}

export function whatsNewCachePath(): string {
  return join(configDir(), "whats-new-cache.json");
}

export function readCache(path: string = whatsNewCachePath()): WhatsNewCache | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<WhatsNewCache>;
    if (typeof parsed.headline !== "string" || typeof parsed.fetchedAt !== "number") return null;
    return { headline: parsed.headline, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

export function writeCache(data: WhatsNewCache, path: string = whatsNewCachePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), "utf8");
  } catch {
    // Cache write failure is non-fatal — banner still renders the fetched headline.
  }
}

export function isFresh(cache: WhatsNewCache, now: number = Date.now()): boolean {
  return now - cache.fetchedAt < CACHE_TTL_MS;
}

export interface LoadWhatsNewOptions {
  url?: string;
  cachePath?: string;
  fetcher?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Synchronous companion to `loadWhatsNew` — returns the best
 * already-known headline (fresh cache, then stale cache, then bundled
 * CHANGELOG head) without ever hitting the network. Designed for
 * first-paint banner rendering where Ink's `<Static>` flushes once
 * and won't pick up an async update.
 */
export function loadWhatsNewSync(
  opts: { cachePath?: string; now?: () => number } = {},
): string | null {
  const cachePath = opts.cachePath ?? whatsNewCachePath();
  const now = opts.now ?? Date.now;
  const cached = readCache(cachePath);
  if (cached && isFresh(cached, now())) return cached.headline;
  return cached?.headline ?? changelogHead();
}

// Returns the headline if a fresh cache or successful remote fetch exists;
// otherwise tries the stale cache, then falls back to the bundled
// CHANGELOG.md head. Never throws.
export async function loadWhatsNew(opts: LoadWhatsNewOptions = {}): Promise<string | null> {
  const url = opts.url ?? whatsNewUrl();
  const cachePath = opts.cachePath ?? whatsNewCachePath();
  const fetcher = opts.fetcher ?? ((u, init) => fetch(u, init));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  const cached = readCache(cachePath);
  if (cached && isFresh(cached, now())) return cached.headline;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { signal: controller.signal });
    if (!res.ok) return cached?.headline ?? changelogHead();
    const body = (await res.json()) as Partial<WhatsNewRemote>;
    if (typeof body.headline !== "string" || body.headline.length === 0) {
      return cached?.headline ?? changelogHead();
    }
    const next: WhatsNewCache = { headline: body.headline, fetchedAt: now() };
    writeCache(next, cachePath);
    return next.headline;
  } catch {
    return cached?.headline ?? changelogHead();
  } finally {
    clearTimeout(timer);
  }
}
