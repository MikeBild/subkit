import { profileIdFor, removeProfile, type StoreData, upsertProfile } from "../profiles.ts";

export interface LocalSignIn {
  origin: string;
  installationId: string;
  cockpitPath: string;
  previousOrigin: string | null;
}

export function applyLocalSignIn(
  data: StoreData,
  signedIn: LocalSignIn,
  options: { setup: boolean; label: string; version: string },
): StoreData {
  const { origin, previousOrigin } = signedIn;
  const active = data.activeProfileId;
  const wasActive = active === null || active === profileIdFor(previousOrigin ?? origin);
  const kept = previousOrigin ? removeProfile(data, profileIdFor(previousOrigin)) : data;
  const next = upsertProfile(kept, origin, {
    label: options.label,
    installationId: signedIn.installationId,
    cockpitPath: signedIn.cockpitPath,
    serverVersion: options.version,
  });
  return wasActive && !options.setup ? { ...next, activeProfileId: profileIdFor(origin) } : next;
}

export function dropLocalProfile(data: StoreData, origin: string | null): StoreData {
  return origin ? removeProfile(data, profileIdFor(origin)) : data;
}

export function isLocalActive(data: StoreData, origin: string | null): boolean {
  return origin !== null && data.activeProfileId === profileIdFor(origin);
}
