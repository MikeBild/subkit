import { homedir } from "node:os";

interface IngestGuardResult {
  rejected: boolean;
  reason?: string;
}

interface IngestGuardInput {
  absolutePath: string;
  sizeBytes: number;
  home?: string;
  platform?: NodeJS.Platform;
}

export const KNOWLEDGE_INGEST_MAX_BYTES = 50 * 1024 * 1024;

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

const HOME_BLOCKED_SUBPATHS: readonly string[] = [
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".kube/",
  ".docker/",
  ".config/",
  ".sk/",
];

const WINDOWS_BLOCKED_PREFIXES_LOWER: readonly string[] = [
  "c:\\windows\\",
  "c:\\program files\\",
  "c:\\program files (x86)\\",
  "c:\\programdata\\",
];

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
