// What's-new resolver for the welcome banner. Fetches a one-line headline
// from a remote JSON endpoint with a 24h on-disk cache; on network
// failure falls back to (a) the last-good cached value if it exists,
// then (b) the head of the bundled CHANGELOG.md. Async — never blocks
// first paint.
//
// Operators can opt out of the network call entirely by setting
// `SK_WHATS_NEW_URL=` (empty) or `SK_WHATS_NEW_URL=disabled` —
// the resolver short-circuits to the bundled-CHANGELOG path. See
// `docs/03-input-surfaces.md` for the air-gapped policy.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
// Build-time embed of the repo's CHANGELOG.md. Bun's text-import bundles
// the file into the compiled binary, so this works both at dev time and
// in the shipped binary (where the source CHANGELOG isn't on disk).
import bundledChangelog from "../../../../../CHANGELOG.md" with { type: "text" };
import { configDir } from "../../config.ts";

const DEFAULT_URL = "https://updates.subkit.dev/whats-new.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

/**
 * W5 of PR #161 review (round 4): when the remote fetch fails this
 * many times in a row, suppress further attempts for
 * `CIRCUIT_OPEN_MS`. Air-gapped operators get the env-var opt-out;
 * unreliable-network operators get the breaker so the REPL doesn't
 * burn 3-second timeouts on every cold-cache boot.
 */
const FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 7 * 24 * 60 * 60 * 1000;

export interface WhatsNewCache {
  headline: string;
  fetchedAt: number;
  /** W5 of round 4: consecutive remote-fetch failure count. Resets on success. */
  failureCount?: number;
  /** W5 of round 4: when the breaker opens, the timestamp it opened at. */
  circuitOpenedAt?: number;
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
    // S7 of PR #161 review (round 5): pass the bundled-CHANGELOG path
    // through the same sanitizer the cache/remote paths use, so a
    // future automated changelog merge that smuggles ANSI/control
    // bytes can't paint over the banner. The earlier code returned
    // the raw `v${version} ${tail}` and only sanitized cache/remote
    // — closing that hole here.
    return sanitizeHeadline(tail ? `v${version} ${tail}` : `v${version}`);
  }
  return null;
}

export interface WhatsNewRemote {
  headline: string;
}

/**
 * W5 of PR #161 review (round 6): Zod schema for the remote payload
 * so a hostile or buggy upstream cannot smuggle nested objects /
 * arrays past `sanitizeHeadline`. `.strict()` rejects unknown keys —
 * if the contract grows, the engine bumps the schema and the CLI
 * surfaces the parse failure as a fetch failure (breaker bumps).
 */
const WhatsNewRemoteSchema = z.object({ headline: z.string() }).strict();

/**
 * Resolve the remote endpoint URL. Returns null when the operator
 * has not explicitly opted in.
 *
 * W4 of PR #161 review (round 6): the default posture is **opt-in**.
 * `SK_WHATS_NEW_URL` unset → no network call (CLI falls back to the
 * bundled CHANGELOG head). To enable, set the env var to the
 * upstream JSON URL. The opt-out sentinels (`""`, `"disabled"`,
 * `"off"`, `"0"`) are kept for compatibility with operators who
 * inherited a populated default and want to disable it explicitly,
 * but they're no longer load-bearing — the default is now silent.
 *
 * Air-gapped deploys remain documented in `docs/03-input-surfaces.md`
 * + `docs/07-security-governance.md`; the default posture matches
 * those docs.
 */
export function whatsNewUrl(): string | null {
  const fromEnv = process.env.SK_WHATS_NEW_URL;
  if (fromEnv === undefined) return null;
  const v = fromEnv.trim();
  if (v.length === 0 || v === "disabled" || v === "off" || v === "0") return null;
  return v;
}

/** Hard-coded default upstream — exported so docs / tests can refer
 *  to it. Operators set `SK_WHATS_NEW_URL=<this>` to opt in. */
export const RECOMMENDED_WHATS_NEW_URL = DEFAULT_URL;

/**
 * ANSI / OSC strip + control-byte filter. Used by `sanitizeHeadline`.
 *
 * Implementation note (W5 of PR #161 review round 2): regex sources
 * use explicit `\x1b` / `\x07` JS escapes only — no literal
 * control bytes embedded in the source — so the file stays text-on
 * disk. The previous version had raw ESC / BEL bytes inside the
 * regex literals, which made `git` flag the file as binary and hid
 * future diffs from review.
 */
function stripAnsiAndControlBytes(input: string): string {
  // CSI: ESC [ <params> <final-byte (A-Za-z)>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC by design
  const noCsi = input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  // OSC: ESC ] <body up to BEL>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC + BEL by design
  const noOsc = noCsi.replace(/\x1b\][^\x07]*\x07/g, "");
  // Any remaining C0 control bytes + DEL (raw ESC, BEL, CR, LF, TAB).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping C0 by design
  return noOsc.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Sanitize a remote- or cache-derived headline before rendering it in
 * the banner. Strips ANSI escape sequences (which would let a
 * poisoned cache hide / repaint the banner area), control characters,
 * and truncates to 80 chars. Returns null when the input collapses
 * to empty.
 */
export function sanitizeHeadline(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const stripped = stripAnsiAndControlBytes(raw);
  const trimmed = stripped.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
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
    const out: WhatsNewCache = { headline: parsed.headline, fetchedAt: parsed.fetchedAt };
    if (typeof parsed.failureCount === "number" && parsed.failureCount >= 0) {
      out.failureCount = parsed.failureCount;
    }
    if (typeof parsed.circuitOpenedAt === "number" && parsed.circuitOpenedAt > 0) {
      out.circuitOpenedAt = parsed.circuitOpenedAt;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * W5 of PR #161 review (round 4): true when the breaker is open —
 * `failureCount >= FAILURE_THRESHOLD` AND the open timestamp is
 * within the last `CIRCUIT_OPEN_MS`. While open, `loadWhatsNew`
 * skips the network call and falls back to cache → bundled
 * CHANGELOG. The next successful fetch resets the breaker.
 */
export function isCircuitOpen(cache: WhatsNewCache | null, now: number): boolean {
  if (!cache) return false;
  if ((cache.failureCount ?? 0) < FAILURE_THRESHOLD) return false;
  if (typeof cache.circuitOpenedAt !== "number") return false;
  return now - cache.circuitOpenedAt < CIRCUIT_OPEN_MS;
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
  fetcher?: (
    url: string,
    init: { signal: AbortSignal; headers?: Record<string, string> },
  ) => Promise<Response>;
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
  if (cached && isFresh(cached, now())) return sanitizeHeadline(cached.headline);
  return sanitizeHeadline(cached?.headline) ?? changelogHead();
}

// Returns the headline if a fresh cache or successful remote fetch exists;
// otherwise tries the stale cache, then falls back to the bundled
// CHANGELOG.md head. Never throws. All headlines (cache, remote,
// CHANGELOG) pass through `sanitizeHeadline` before return so a
// poisoned cache or hostile remote can't inject ANSI control bytes
// into the banner.
export async function loadWhatsNew(opts: LoadWhatsNewOptions = {}): Promise<string | null> {
  const cachePath = opts.cachePath ?? whatsNewCachePath();
  const fetcher = opts.fetcher ?? ((u, init) => fetch(u, init));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  // Resolve the URL. `null` = operator disabled the network call —
  // skip straight to cache → bundled CHANGELOG.
  const url = opts.url ?? whatsNewUrl();
  if (url === null) {
    const cached = readCache(cachePath);
    return sanitizeHeadline(cached?.headline) ?? changelogHead();
  }

  const cached = readCache(cachePath);
  if (cached && isFresh(cached, now())) return sanitizeHeadline(cached.headline);

  // W5 of PR #161 review (round 4): if the breaker is open we never
  // touch the network. The cache is served (stale-OK) and the
  // bundled CHANGELOG covers the empty-cache case.
  if (isCircuitOpen(cached, now())) {
    return sanitizeHeadline(cached?.headline) ?? changelogHead();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // W5 of PR #161 review (round 4): identify CLI traffic in the
  // upstream's access log. Operators inspecting `updates.subkit.dev`
  // logs need to be able to tell sk-cli requests from generic Bun
  // fetches in case throttling / quota policies need to apply.
  // `BUILD_VERSION` is bun-`define`d at compile time — fall back to
  // a literal "unknown" when running under bun test where the define
  // isn't replaced.
  // biome-ignore lint/suspicious/noExplicitAny: BUILD_VERSION is a build-time replace
  const declaredVersion = (globalThis as any).BUILD_VERSION;
  const skVersion = typeof declaredVersion === "string" ? declaredVersion : "unknown";
  const userAgent = `sk-cli/${skVersion}`;

  try {
    const res = await fetcher(url, {
      signal: controller.signal,
      headers: { "user-agent": userAgent },
    });
    if (!res.ok) {
      recordFailure(cached, cachePath, now());
      return sanitizeHeadline(cached?.headline) ?? changelogHead();
    }
    // W5 of PR #161 review (round 6): Zod-validate the remote payload
    // before render. `.strict()` rejects unknown keys; failure is
    // counted as a fetch failure (breaker bumps), not silently
    // smuggled through `sanitizeHeadline`.
    const rawBody = (await res.json()) as unknown;
    const parsed = WhatsNewRemoteSchema.safeParse(rawBody);
    if (!parsed.success) {
      recordFailure(cached, cachePath, now());
      return sanitizeHeadline(cached?.headline) ?? changelogHead();
    }
    const sanitized = sanitizeHeadline(parsed.data.headline);
    if (sanitized === null) {
      recordFailure(cached, cachePath, now());
      return sanitizeHeadline(cached?.headline) ?? changelogHead();
    }
    // Success — reset the breaker counters.
    const next: WhatsNewCache = {
      headline: sanitized,
      fetchedAt: now(),
      failureCount: 0,
    };
    writeCache(next, cachePath);
    return sanitized;
  } catch {
    recordFailure(cached, cachePath, now());
    return sanitizeHeadline(cached?.headline) ?? changelogHead();
  } finally {
    clearTimeout(timer);
  }
}

function recordFailure(cached: WhatsNewCache | null, cachePath: string, now: number): void {
  const nextCount = (cached?.failureCount ?? 0) + 1;
  const next: WhatsNewCache = {
    headline: cached?.headline ?? "",
    fetchedAt: cached?.fetchedAt ?? 0,
    failureCount: nextCount,
  };
  if (nextCount >= FAILURE_THRESHOLD) {
    next.circuitOpenedAt = cached?.circuitOpenedAt ?? now;
  }
  writeCache(next, cachePath);
}
