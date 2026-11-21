export const PAUSE_PRESET_MINUTES = [60, 240, 480] as const;

export interface NotificationPauseBody {
  readonly paused: boolean;
  readonly mode: "until" | "until_resumed" | null;
  readonly paused_at: string | null;
  readonly until: string | null;
}

export type NotificationPauseState =
  | { readonly kind: "off" }
  | { readonly kind: "until"; readonly until: number; readonly remaining_ms: number }
  | { readonly kind: "until_resumed"; readonly since: number | null };

export function pauseState(
  body: NotificationPauseBody | null | undefined,
  now: number,
): NotificationPauseState {
  if (!body?.paused) return { kind: "off" };
  if (body.mode === "until" && body.until) {
    const until = Date.parse(body.until);
    if (!Number.isFinite(until) || until <= now) return { kind: "off" };
    return { kind: "until", until, remaining_ms: until - now };
  }
  const since = body.paused_at ? Date.parse(body.paused_at) : Number.NaN;
  return { kind: "until_resumed", since: Number.isFinite(since) ? since : null };
}

export function isPausedAt(body: NotificationPauseBody | null | undefined, now: number): boolean {
  return pauseState(body, now).kind !== "off";
}

export function pauseRequestForMinutes(minutes: number): { mode: "for"; minutes: number } {
  return { mode: "for", minutes: Math.max(1, Math.round(minutes)) };
}

export function pauseUntilForMinutes(now: number, minutes: number): number {
  return now + Math.max(1, Math.round(minutes)) * 60_000;
}
