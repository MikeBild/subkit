// Long-running execution notifications.
//
// Emits two terminal escape sequences in tandem:
//   - OSC 9 (`\x1b]9;<title>\x07`) — picked up by iTerm2, recent
//     gnome-terminal, Konsole, Windows Terminal, WezTerm.
//   - BEL  (`\x07`)               — universal fallback; some
//     terminals visually flash, others ring a sound.
//
// The combination matches Codex's notification helper. No native OS
// dependency; everything is stdout writes.
//
// Throttling + opt-in: `notify()` no-ops when:
//   - the threshold has not been reached, OR
//   - opt-in is false, OR
//   - quiet hours are active (caller-supplied check).

export interface NotifyOptions {
  /** Caller-side opt-in flag. When false, notify() is a no-op. */
  enabled: boolean;
  /** Minimum elapsed milliseconds before a notification fires. */
  thresholdMs: number;
  /** Optional quiet-hours predicate; when it returns true the notify is suppressed. */
  quietHours?: () => boolean;
  /** Stream override for tests. */
  stream?: NodeJS.WriteStream;
}

const DEFAULT_THRESHOLD_MS = 30_000;

export function shouldNotify(elapsedMs: number, opts: NotifyOptions): boolean {
  if (!opts.enabled) return false;
  if (elapsedMs < opts.thresholdMs) return false;
  if (opts.quietHours?.()) return false;
  return true;
}

/**
 * Emit a terminal notification for a long-running execution. Returns
 * true when the escape sequences were written.
 */
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
  // OSC 9 is `ESC ] 9 ; <text> BEL`. We follow with a standalone BEL
  // so terminals that ignore OSC 9 still get an audible/visual cue.
  stream.write(`\x1b]9;${message}\x07`);
  stream.write("\x07");
  return true;
}

export const NOTIFY_DEFAULTS: { thresholdMs: number } = {
  thresholdMs: DEFAULT_THRESHOLD_MS,
};

/**
 * Time-window quiet-hours predicate. `start` and `end` are "HH:MM"
 * strings in the local timezone. An empty string at either end
 * disables the window. The window may wrap midnight: when `start >
 * end`, the active window is `[start, 24:00) ∪ [00:00, end)`.
 *
 * H1 closure of #159 G3 — pairs with the `notifications.push.quietHours*`
 * engine settings.
 */
export function inQuietHoursWindow(start: string, end: string, now: Date): boolean {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === null || e === null) return false;
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  if (s === e) return false;
  if (s < e) return minutesNow >= s && minutesNow < e;
  // Wraps midnight.
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

/**
 * H11 closure of #159 — best-effort OS Do-Not-Disturb probe. Returns
 * true only when the platform reports DND active; on any failure
 * (unsupported OS, missing tooling, permission error, timeout)
 * returns false so the caller falls back to the time-window check.
 *
 * macOS: uses `defaults read com.apple.ncprefs.plist dnd_prefs` style
 *   probes which are unreliable across versions; instead we inspect
 *   the Focus state via `defaults read ~/Library/Preferences/com.apple.controlcenter.plist`.
 *   When that's absent we conservatively return false.
 *
 * Linux: GNOME exposes `gsettings get org.gnome.desktop.notifications
 *   show-banners`; KDE exposes `qdbus org.kde.plasmashell` — both
 *   probed opportunistically.
 *
 * Windows: not supported here; the OS itself respects Focus Assist
 *   for OSC9 notifications already.
 */
export function isOsDoNotDisturb(): boolean {
  try {
    // The `node:child_process` import is dynamic so the bundled binary
    // doesn't pay the eager-import cost on every notify() call.
    const cp = require("node:child_process") as typeof import("node:child_process");
    const plat = process.platform;
    if (plat === "darwin") {
      const r = cp.spawnSync(
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
      const r = cp.spawnSync(
        "gsettings",
        ["get", "org.gnome.desktop.notifications", "show-banners"],
        { encoding: "utf8", timeout: 200 },
      );
      if (r.status === 0 && /false/.test(r.stdout)) return true;
      return false;
    }
    return false;
  } catch {
    return false;
  }
}
