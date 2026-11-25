const ALWAYS_ALLOWED = new Set(["notifications", "clipboard-sanitized-write"]);

export interface PermissionAsk {
  readonly permission: string;
  readonly requester: string | null;
  readonly serverOrigin: string | null;
  readonly mediaTypes: readonly string[];
}

export const isMicrophoneOnly = (mediaTypes: readonly string[]): boolean =>
  mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");

export function permissionGranted(ask: PermissionAsk): boolean {
  if (ask.serverOrigin === null || ask.requester !== ask.serverOrigin) return false;
  if (ALWAYS_ALLOWED.has(ask.permission)) return true;
  return ask.permission === "media" && isMicrophoneOnly(ask.mediaTypes);
}

export const wantsMicrophone = (ask: PermissionAsk): boolean =>
  ask.permission === "media" && permissionGranted(ask);
