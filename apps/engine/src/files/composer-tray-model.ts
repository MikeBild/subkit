export const COMPOSER_TRAY_LIMIT = 10;
export const COMPOSER_TRAY_TTL_MS = 24 * 60 * 60 * 1000;

export interface TrayEntry {
  id: string;
  file_id: string;
  expires_at: Date;
}

export function composerExpiry(now: Date): Date {
  return new Date(now.getTime() + COMPOSER_TRAY_TTL_MS);
}

export function liveEntries<T extends TrayEntry>(entries: readonly T[], now: Date): T[] {
  return entries.filter((entry) => entry.expires_at.getTime() > now.getTime());
}

export type TrayAdmission = "add" | "refresh" | "full";

export function trayAdmission(
  live: readonly TrayEntry[],
  file_id: string,
  limit = COMPOSER_TRAY_LIMIT,
): TrayAdmission {
  if (live.some((entry) => entry.file_id === file_id)) return "refresh";
  return live.length >= limit ? "full" : "add";
}

export type ClaimSelection<T> = { ok: true; claim: T[] } | { ok: false; missing: string[] };

export function claimSelection<T extends TrayEntry>(
  live: readonly T[],
  ids: readonly string[] | undefined,
): ClaimSelection<T> {
  if (ids === undefined) return { ok: true, claim: [...live] };
  const wanted = [...new Set(ids)];
  const byId = new Map(live.map((entry) => [entry.id, entry]));
  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, claim: wanted.map((id) => byId.get(id) as T) };
}
