export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
}

const VERSION = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== "string") return null;
  const match = VERSION.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: Boolean(match[4]),
  };
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  return left.prerelease ? -1 : 1;
}

export type Compatibility = "compatible" | "server-too-old" | "app-too-old" | "login-unsupported";

export interface HandshakeInput {
  appVersion: string;
  serverVersion: string;
  minServerVersion: string;
  minAppVersion: string | null;
  desktopSupported: boolean;
  loginSupported: boolean;
}

export function handshake(input: HandshakeInput): Compatibility {
  if (!input.desktopSupported) return "server-too-old";
  const server = compareVersions(input.serverVersion, input.minServerVersion);
  if (server === null || server < 0) return "server-too-old";
  if (!input.loginSupported) return "login-unsupported";
  if (input.minAppVersion === null) return "compatible";
  const app = compareVersions(input.appVersion, input.minAppVersion);
  if (app === null || app < 0) return "app-too-old";
  return "compatible";
}
