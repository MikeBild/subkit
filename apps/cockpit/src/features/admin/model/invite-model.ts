export { INVITE_PAGE, inviteLink } from "@/features/admin/model/invite-link";

export function inviteToken(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  let token: string;
  try {
    token = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  return token.length >= 14 && token.length <= 128 && !/\s/.test(token) ? token : null;
}

export const DESKTOP_LOGIN_START = "/v1/identity/desktop-login/start";

export function desktopContinuation(raw: string | null, origin: string): string | null {
  if (!raw?.startsWith("/") || raw.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname !== DESKTOP_LOGIN_START || url.hash) return null;
  return `${url.pathname}${url.search}`;
}

export function inviteContinuation(search: string, origin: string): string | null {
  return desktopContinuation(new URLSearchParams(search).get("continue"), origin);
}

export function inviteReturned(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("joined") === "1" || Boolean(params.get("error"));
}

export function joinCommand(origin: string, token: string): string {
  return `subkit join --invite ${token} --engine-url ${origin}`;
}

export interface InvitePreview {
  workspace_name: string;
  invited_by_name: string | null;
  email_hint: string;
  expires_at: string;
  providers: readonly { id: string; label: string }[];
}

export type InviteView =
  | { kind: "loading" }
  | { kind: "open"; preview: InvitePreview }
  | { kind: "cli"; token: string }
  | { kind: "joined" }
  | { kind: "mismatch"; retry: boolean }
  | { kind: "expired" }
  | { kind: "gone"; signIn: boolean }
  | { kind: "invalid" }
  | { kind: "unavailable" }
  | { kind: "unreachable" };

function refusedSignIn(code: string, token: string | null): InviteView {
  if (code === "identity_mismatch") return { kind: "mismatch", retry: token !== null };
  if (code === "invite_invalid") return { kind: "invalid" };
  if (code === "invite_unavailable") return { kind: "gone", signIn: false };
  return { kind: "unavailable" };
}

function refusedPreview(code: string | null, token: string): InviteView {
  if (code === "invite_invalid") return { kind: "invalid" };
  if (code === "invite_expired") return { kind: "expired" };
  if (code === "invite_revoked" || code === "invite_unavailable")
    return { kind: "gone", signIn: false };
  if (code === "invite_already_redeemed") return { kind: "gone", signIn: true };
  if (code === "invite_credential_only") return { kind: "cli", token };
  return { kind: "unreachable" };
}

export function inviteView(input: {
  search: string;
  token: string | null;
  preview: { data: InvitePreview | undefined; failed: boolean; code: string | null };
}): InviteView {
  const params = new URLSearchParams(input.search);
  if (params.get("joined") === "1") return { kind: "joined" };
  const refusal = params.get("error");
  if (refusal) return refusedSignIn(refusal, input.token);
  if (!input.token) return { kind: "invalid" };
  if (input.preview.data) {
    return input.preview.data.providers.length === 0
      ? { kind: "cli", token: input.token }
      : { kind: "open", preview: input.preview.data };
  }
  if (input.preview.failed) return refusedPreview(input.preview.code, input.token);
  return { kind: "loading" };
}

export type RefusedInvite = Extract<
  InviteView,
  { kind: "mismatch" | "expired" | "gone" | "invalid" | "unavailable" | "unreachable" }
>;

export type InviteSession = "signed-in" | "signed-out" | "unknown";

export interface RefusalActions {
  primary: "other-address" | "retry" | "sign-in" | "home";
  back: boolean;
}

export function refusalActions(view: RefusedInvite, session: InviteSession): RefusalActions {
  const base =
    view.kind === "mismatch" && view.retry
      ? "other-address"
      : view.kind === "unreachable"
        ? "retry"
        : "sign-in";
  if (session !== "signed-in") return { primary: base, back: false };
  if (base === "sign-in") return { primary: "home", back: false };
  return { primary: base, back: true };
}
