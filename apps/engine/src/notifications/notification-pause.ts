export const PAUSE_MAX_MINUTES = 30 * 24 * 60;

export interface StoredPause {
  readonly paused_at: Date | null;
  readonly paused_until: Date | null;
}

export type PauseRequest =
  | { readonly mode: "for"; readonly minutes: number }
  | { readonly mode: "until"; readonly until: Date }
  | { readonly mode: "until_resumed" };

export interface PauseView {
  readonly paused: boolean;
  readonly mode: "until" | "until_resumed" | null;
  readonly paused_at: Date | null;
  readonly until: Date | null;
}

export type PausePlan =
  | { readonly ok: true; readonly paused_at: Date; readonly paused_until: Date | null }
  | { readonly ok: false; readonly reason: "pause_in_past" | "pause_too_long" };

export function pauseActive(pause: StoredPause, at: Date): boolean {
  if (!pause.paused_at) return false;
  if (pause.paused_at.getTime() > at.getTime()) return false;
  return pause.paused_until === null || pause.paused_until.getTime() > at.getTime();
}

export function pauseView(pause: StoredPause, at: Date): PauseView {
  if (!pauseActive(pause, at)) return { paused: false, mode: null, paused_at: null, until: null };
  return {
    paused: true,
    mode: pause.paused_until ? "until" : "until_resumed",
    paused_at: pause.paused_at,
    until: pause.paused_until,
  };
}

export function planPause(request: PauseRequest, at: Date): PausePlan {
  if (request.mode === "until_resumed") return { ok: true, paused_at: at, paused_until: null };
  const until =
    request.mode === "for" ? new Date(at.getTime() + request.minutes * 60_000) : request.until;
  if (until.getTime() <= at.getTime()) return { ok: false, reason: "pause_in_past" };
  if (until.getTime() - at.getTime() > PAUSE_MAX_MINUTES * 60_000)
    return { ok: false, reason: "pause_too_long" };
  return { ok: true, paused_at: at, paused_until: until };
}
