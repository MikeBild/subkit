import type { MessageKey } from "../../shared/i18n.ts";
import type { ConnectState, ConnectView } from "../../shared/ipc.ts";
import { setupComplete } from "../../shared/onboarding.ts";

export interface NavTrail {
  trail: ConnectView[];
  requested: ConnectView | null;
}

export const EMPTY_TRAIL: NavTrail = { trail: [], requested: null };

export type ReturnTarget =
  | { kind: "view"; view: ConnectView }
  | { kind: "cockpit"; profileId: string }
  | { kind: "wizard" };

export type ReturnLabel = Extract<MessageKey, "common.back" | "common.close">;

export const DIRECT_VIEWS: readonly ConnectView[] = ["settings", "local", "permissions", "report"];

export function isDirectView(view: ConnectView): boolean {
  return DIRECT_VIEWS.includes(view);
}

export function activeSignedIn(state: ConnectState): string | null {
  return state.profiles.find((profile) => profile.active && profile.signedIn)?.id ?? null;
}

export function homeTarget(state: ConnectState): ReturnTarget {
  const profileId = activeSignedIn(state);
  return setupComplete(state) && profileId ? { kind: "cockpit", profileId } : { kind: "wizard" };
}

export function returnTarget(state: ConnectState, nav: NavTrail): ReturnTarget {
  const previous = nav.trail.at(-1);
  return previous ? { kind: "view", view: previous } : homeTarget(state);
}

export function returnLabel(target: ReturnTarget): ReturnLabel {
  return target.kind === "cockpit" ? "common.close" : "common.back";
}

export function navigated(nav: NavTrail, from: ConnectView, to: ConnectView): NavTrail {
  if (from === to) return nav;
  return { trail: [...nav.trail, from], requested: to };
}

export function wentBack(nav: NavTrail, to: ConnectView): NavTrail {
  return { trail: nav.trail.slice(0, -1), requested: to };
}

export function wentHome(): NavTrail {
  return { trail: [], requested: "connect" };
}

export function viewChanged(
  nav: NavTrail,
  before: ConnectView | null,
  after: ConnectView,
): NavTrail {
  if (before === after) return nav;
  if (nav.requested === after) return { ...nav, requested: null };
  return EMPTY_TRAIL;
}

export interface DirectNav {
  back: ReturnLabel | null;
  later: boolean;
}

export function directNavFor(view: ConnectView, state: ConnectState, nav: NavTrail): DirectNav {
  const target = returnTarget(state, nav);
  const fromOutside = nav.trail.length === 0;
  if (view === "permissions" && fromOutside) return { back: null, later: true };
  return { back: returnLabel(target), later: false };
}
