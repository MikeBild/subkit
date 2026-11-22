import { desktopContinuation, inviteContinuation, inviteReturned } from "./model/invite-model";

const KEY = "subkit.invite.continue";

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function rememberInviteContinuation(search: string, origin: string): void {
  if (inviteReturned(search)) return;
  const store = sessionStore();
  const next = inviteContinuation(search, origin);
  try {
    if (next) store?.setItem(KEY, next);
    else store?.removeItem(KEY);
  } catch {}
}

export function afterJoinTarget(origin: string, fallback: string): string {
  const store = sessionStore();
  try {
    const next = desktopContinuation(store?.getItem(KEY) ?? null, origin);
    store?.removeItem(KEY);
    return next ?? fallback;
  } catch {
    return fallback;
  }
}
