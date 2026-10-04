import { spawnSync } from "node:child_process";

export interface NotifyOptions {
  enabled: boolean;
  thresholdMs: number;
  quietHours?: () => boolean;
  stream?: NodeJS.WriteStream;
}

const DEFAULT_THRESHOLD_MS = 30_000;

export function shouldNotify(elapsedMs: number, opts: NotifyOptions): boolean {
  if (!opts.enabled) return false;
  if (elapsedMs < opts.thresholdMs) return false;
  if (opts.quietHours?.()) return false;
  return true;
}

export function notify(
  title: string,
  body: string | undefined,
  elapsedMs: number,
  opts: NotifyOptions = { enabled: true, thresholdMs: DEFAULT_THRESHOLD_MS },
): boolean {
  if (!shouldNotify(elapsedMs, opts)) return false;
  const stream = opts.stream ?? process.stdout;
  if (!stream.isTTY) return false;
  const message = body ? `${title} — ${body}` : title;
  stream.write(`\x1b]9;${message}\x07`);
  stream.write("\x07");
  return true;
}

export const NOTIFY_DEFAULTS: { thresholdMs: number } = {
  thresholdMs: DEFAULT_THRESHOLD_MS,
};

export function inQuietHoursWindow(start: string, end: string, now: Date): boolean {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === null || e === null) return false;
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  if (s === e) return false;
  if (s < e) return minutesNow >= s && minutesNow < e;
  return minutesNow >= s || minutesNow < e;
}

function parseHHMM(s: string): number | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

const OS_DND_CACHE_TTL_MS = 5 * 60 * 1000;

interface OsDndCacheEntry {
  value: boolean;
  expiresAt: number;
}

let osDndCache: OsDndCacheEntry | null = null;

export function isOsDoNotDisturb(now: number = Date.now()): boolean {
  if (osDndCache !== null && now < osDndCache.expiresAt) return osDndCache.value;
  const value = probeOsDoNotDisturb();
  osDndCache = { value, expiresAt: now + OS_DND_CACHE_TTL_MS };
  return value;
}

function probeOsDoNotDisturb(): boolean {
  try {
    const plat = process.platform;
    if (plat === "darwin") {
      const r = spawnSync(
        "defaults",
        ["read", "com.apple.controlcenter", "NSStatusItem Visible FocusModes"],
        {
          encoding: "utf8",
          timeout: 200,
        },
      );
      if (r.status === 0 && /1\b/.test(r.stdout)) return true;
      return false;
    }
    if (plat === "linux") {
      const r = spawnSync("gsettings", ["get", "org.gnome.desktop.notifications", "show-banners"], {
        encoding: "utf8",
        timeout: 200,
      });
      if (r.status === 0 && /false/.test(r.stdout)) return true;
      return false;
    }
    return false;
  } catch {
    return false;
  }
}
