// W6 of PR #161 review (round 6): UX guard for the Knowledge tab's
// inline ingest path. Lifted out of KnowledgeTab.tsx so the contract
// is unit-testable without driving the Ink render tree, and so a
// future contributor cannot widen one half (the deny-list) without
// the other half (the test) lighting up.
//
// This is **not** a security boundary. The engine accepts whatever
// bytes the operator forwards, scopes them to the tenant, and runs
// them through the standard Knowledge ingest pipeline. The guard
// catches typos and accidental log-tail / dotfile selections that
// would either OOM the REPL or leak host-internal state into a
// tenant Knowledge Source.

import { homedir } from "node:os";

export interface IngestGuardResult {
  /** True when the guard rejected the path/size; the caller should
   *  surface `reason` to the operator and abort the ingest. */
  rejected: boolean;
  reason?: string;
}

/** Inputs to the guard. `homedir` is injected so tests can supply
 *  fake `~` roots without monkey-patching `os`. */
export interface IngestGuardInput {
  /** Absolute path the operator typed (post-`isAbsolute` resolve). */
  absolutePath: string;
  /** File size in bytes from `fs.stat`. */
  sizeBytes: number;
  /** Override for `homedir()` — tests pass deterministic values. */
  home?: string;
  /** Override for `process.platform` — tests cover both branches. */
  platform?: NodeJS.Platform;
}

/** 50 MB ceiling — enough for any reasonable doc, low enough that a
 *  stray `/var/log/...` selection doesn't OOM the REPL. */
export const KNOWLEDGE_INGEST_MAX_BYTES = 50 * 1024 * 1024;

/** Unix paths that are almost never a deliberate Knowledge Source.
 *  Excludes `/var/` outright because macOS resolves `tmpdir()` to
 *  `/var/folders/...`, which IS a legitimate ingest source. The
 *  log + lib + run + spool subdirs are added explicitly so a
 *  `/var/log/auth.log` selection is still rejected. */
const UNIX_BLOCKED_PREFIXES: readonly string[] = [
  "/etc/",
  "/proc/",
  "/sys/",
  "/var/log/",
  "/var/lib/",
  "/var/run/",
  "/var/spool/",
  "/dev/",
  "/root/",
];

/** Per-home-directory dotfile prefixes that contain credentials,
 *  bookmarks, or terminal history. Resolved against the active
 *  `homedir()` so each operator's dotfiles are blocked relative
 *  to their own home, not a literal `~/`. */
const HOME_BLOCKED_SUBPATHS: readonly string[] = [
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".kube/",
  ".docker/",
  ".config/",
  ".sk/",
];

/** Windows root directories that the guard refuses outright. The
 *  comparison is case-insensitive because Windows file systems are
 *  case-insensitive by default. */
const WINDOWS_BLOCKED_PREFIXES_LOWER: readonly string[] = [
  "c:\\windows\\",
  "c:\\program files\\",
  "c:\\program files (x86)\\",
  "c:\\programdata\\",
];

/** Per-home-directory blocked subpaths on Windows (e.g. AppData,
 *  the Windows clone of `~/.ssh`). Resolved against `homedir()`. */
const WINDOWS_HOME_BLOCKED_SUBPATHS_LOWER: readonly string[] = ["appdata\\", ".ssh\\", ".aws\\"];

export function checkIngestGuard(input: IngestGuardInput): IngestGuardResult {
  const { absolutePath, sizeBytes } = input;
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();

  if (sizeBytes > KNOWLEDGE_INGEST_MAX_BYTES) {
    return {
      rejected: true,
      reason: `ingest refused: file is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB (max 50 MB) — split or compress first`,
    };
  }

  if (platform === "win32") {
    const lower = absolutePath.toLowerCase();
    for (const prefix of WINDOWS_BLOCKED_PREFIXES_LOWER) {
      if (lower.startsWith(prefix)) {
        return refuseOsInternal(absolutePath);
      }
    }
    if (home.length > 0) {
      const homeLower = home.toLowerCase();
      for (const sub of WINDOWS_HOME_BLOCKED_SUBPATHS_LOWER) {
        const blocked = `${homeLower}\\${sub}`.toLowerCase();
        if (lower.startsWith(blocked)) {
          return refuseDotfile(absolutePath);
        }
      }
    }
    return { rejected: false };
  }

  // POSIX path
  for (const prefix of UNIX_BLOCKED_PREFIXES) {
    if (absolutePath.startsWith(prefix) || absolutePath === prefix.slice(0, -1)) {
      return refuseOsInternal(absolutePath);
    }
  }
  if (home.length > 0) {
    for (const sub of HOME_BLOCKED_SUBPATHS) {
      const blocked = `${home}/${sub}`;
      if (absolutePath.startsWith(blocked)) {
        return refuseDotfile(absolutePath);
      }
    }
  }
  return { rejected: false };
}

function refuseOsInternal(_absolutePath: string): IngestGuardResult {
  return {
    rejected: true,
    reason:
      "ingest refused: path is OS-internal (system / log / device tree) — pick a project path",
  };
}

function refuseDotfile(_absolutePath: string): IngestGuardResult {
  return {
    rejected: true,
    reason:
      "ingest refused: path is inside a credentials / config dotfile root — pick a project path",
  };
}
