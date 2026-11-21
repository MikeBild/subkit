import { execFile } from "node:child_process";

const XATTR = "/usr/bin/xattr";
export const QUARANTINE_ATTRIBUTE = "com.apple.quarantine";

export function quarantineValue(now: number): string {
  return `0082;${Math.floor(now / 1000).toString(16)};SubKit;`;
}

export function markQuarantine(path: string, now: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      XATTR,
      ["-w", QUARANTINE_ATTRIBUTE, quarantineValue(now), path],
      { env: {}, timeout: 5_000 },
      (error) => resolve(!error),
    );
  });
}
