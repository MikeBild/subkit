import { apiUrl } from "./clipper.ts";

export const updateCheckKey = "updateCheck";
export const updateCheckIntervalMs = 24 * 60 * 60 * 1000;
export const descriptorPath = "/.well-known/service-descriptor.json";
export const downloadPath = "/install/clipper.zip";

export type InstallType = "admin" | "development" | "normal" | "sideload" | "other";

export interface UpdateCheck {
  engineUrl: string;
  checkedAt: number;
  version: string | null;
}

export interface UpdateNotice {
  version: string;
  downloadUrl: string;
}

type Version = readonly [number, number, number];

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseVersion(value: unknown): Version | undefined {
  if (typeof value !== "string") return undefined;
  const match = VERSION.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewer(candidate: string, installed: string): boolean {
  const next = parseVersion(candidate);
  const current = parseVersion(installed);
  if (!next || !current) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (next[index] ?? 0) - (current[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export function updatesItself(installType: InstallType | undefined): boolean {
  return installType === "normal" || installType === "admin";
}

export function descriptorVersion(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const version = (payload as { version?: unknown }).version;
  return parseVersion(version) ? (version as string).trim().replace(/^v/, "") : null;
}

export function parseUpdateCheck(value: unknown): UpdateCheck | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.engineUrl !== "string" || typeof record.checkedAt !== "number") {
    return undefined;
  }
  return {
    engineUrl: record.engineUrl,
    checkedAt: record.checkedAt,
    version: typeof record.version === "string" ? record.version : null,
  };
}

export function needsCheck(
  previous: UpdateCheck | undefined,
  engineUrl: string,
  now: number,
): boolean {
  if (!previous || previous.engineUrl !== engineUrl) return true;
  return now < previous.checkedAt || now - previous.checkedAt >= updateCheckIntervalMs;
}

export function updateNotice(input: {
  installed: string;
  installType: InstallType | undefined;
  check: UpdateCheck | undefined;
}): UpdateNotice | undefined {
  const { check } = input;
  if (updatesItself(input.installType) || !check?.version) return undefined;
  if (!isNewer(check.version, input.installed)) return undefined;
  return { version: check.version, downloadUrl: apiUrl(check.engineUrl, downloadPath) };
}

export interface UpdateCheckDeps {
  load(): Promise<unknown>;
  store(check: UpdateCheck): Promise<void>;
  fetchDescriptor(url: string): Promise<unknown>;
  now(): number;
}

export async function currentUpdateCheck(
  engineUrl: string,
  deps: UpdateCheckDeps,
): Promise<UpdateCheck | undefined> {
  const previous = parseUpdateCheck(await deps.load());
  const now = deps.now();
  if (!needsCheck(previous, engineUrl, now)) return previous;
  let version: string | null;
  try {
    version = descriptorVersion(await deps.fetchDescriptor(apiUrl(engineUrl, descriptorPath)));
  } catch {
    return previous?.engineUrl === engineUrl ? previous : undefined;
  }
  const next = { engineUrl, checkedAt: now, version };
  await deps.store(next);
  return next;
}
