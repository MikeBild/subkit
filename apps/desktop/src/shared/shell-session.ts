import type { VaultApproval } from "./attention.ts";
import type { ConnectNotice, ConnectView, LoginPhase, ProfileSummary, SignedIn } from "./ipc.ts";
import { LOADING_ONBOARDING, NO_ONBOARDING, type Onboarding } from "./onboarding.ts";
import { isSignedIn, type Profile, type StoreData } from "./profiles.ts";
import type { AuthFailure } from "./server-contract.ts";
import type { TooOldAsk } from "./server-too-old.ts";
import { type StatusNotice, statusNotice } from "./status-model.ts";
import type { Connection } from "./tray-model.ts";

export interface ShellSession {
  readonly connection: Connection;
  readonly count: number;
  readonly approval: VaultApproval | null;
  readonly login: LoginPhase;
  readonly notice: { readonly kind: ConnectNotice; readonly profileId: string } | null;
  readonly view: ConnectView;
  readonly signedIn: SignedIn | null;
  readonly onboarding: Onboarding;
  readonly tooOld: TooOldAsk | null;
}

export const INITIAL_SESSION: ShellSession = {
  connection: "signed-out",
  count: 0,
  approval: null,
  login: { phase: "idle" },
  notice: null,
  view: "connect",
  signedIn: null,
  onboarding: NO_ONBOARDING,
  tooOld: null,
};

export function profileSummaries(data: StoreData): ProfileSummary[] {
  return data.profiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    serverOrigin: profile.serverOrigin,
    signedIn: isSignedIn(profile),
    active: profile.id === data.activeProfileId,
    serverVersion: profile.serverVersion,
  }));
}

export function showsCockpit(
  session: ShellSession,
  profile: Profile | null,
): profile is Profile & { cockpitPath: string } {
  return isSignedIn(profile) && session.notice?.profileId !== profile.id;
}

export function connectShown(session: ShellSession, view: ConnectView): ShellSession {
  return { ...session, view, signedIn: null, onboarding: NO_ONBOARDING };
}

export interface ConnectionChange {
  readonly session: ShellSession;
  readonly notice: StatusNotice | null;
  readonly cameOnline: boolean;
}

export function connectionChanged(session: ShellSession, next: Connection): ConnectionChange {
  return {
    session: { ...session, connection: next },
    notice: statusNotice(session.connection, next),
    cameOnline: next === "online" && session.connection !== "online",
  };
}

export function feedStopped(session: ShellSession): ShellSession {
  const notice = session.notice;
  return {
    ...session,
    tooOld: null,
    connection: notice && notice.kind !== "offline" ? notice.kind : "signed-out",
  };
}

export function feedStarted(session: ShellSession): ShellSession {
  return { ...session, tooOld: null, connection: "connecting" };
}

function withoutOfflineNotice(session: ShellSession, profileId: string): ShellSession {
  const notice = session.notice;
  return notice?.kind === "offline" && notice.profileId === profileId
    ? { ...session, notice: null }
    : session;
}

export function backOnline(session: ShellSession, profileId: string): ShellSession {
  return withoutOfflineNotice(session, profileId);
}

export function profileActivated(
  session: ShellSession,
  profileId: string,
  switched: boolean,
): ShellSession {
  const next = withoutOfflineNotice(session, profileId);
  return switched ? { ...next, count: 0, approval: null } : next;
}

export function authFailed(
  session: ShellSession,
  profileId: string,
  failure: AuthFailure,
): ShellSession {
  return { ...session, count: 0, approval: null, notice: { kind: failure, profileId } };
}

export function cockpitUnreachable(session: ShellSession, profileId: string): ShellSession {
  return { ...session, notice: { kind: "offline", profileId } };
}

export function serverRemoved(session: ShellSession, profileId: string): ShellSession {
  return {
    ...session,
    count: 0,
    approval: null,
    notice: session.notice?.profileId === profileId ? null : session.notice,
  };
}

export function signedInTo(session: ShellSession, signedIn: SignedIn): ShellSession {
  return {
    ...session,
    notice: null,
    count: 0,
    approval: null,
    signedIn,
    onboarding: LOADING_ONBOARDING,
    view: "connect",
  };
}

export function loginMoved(session: ShellSession, login: LoginPhase): ShellSession {
  return { ...session, login };
}

export function needsYou(
  session: ShellSession,
  count: number,
  approval: VaultApproval | null = null,
): ShellSession {
  return { ...session, count, approval };
}

export function deviceIdFor(
  known: string | null | undefined,
  pending: ReadonlyMap<string, string>,
  profileId: string,
  created: string,
): { id: string; pending: ReadonlyMap<string, string> } {
  const existing = known ?? pending.get(profileId);
  if (existing) return { id: existing, pending };
  return { id: created, pending: new Map(pending).set(profileId, created) };
}
