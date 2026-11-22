import type { CheckResult } from "./ipc.ts";
import { normalizeServerAddress } from "./server-address.ts";

export const INVITE_PAGE_PATH = "/cockpit/invite";
export const INVITE_PREVIEW_PATH = "/v1/identity/invites/preview";

const TOKEN = /^wf_invite_[A-Za-z0-9_-]{8,118}$/;

export interface InviteLink {
  origin: string;
  token: string;
}

export function parseInviteLink(raw: string): InviteLink | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search) return null;
  const address = normalizeServerAddress(url.origin);
  if (!address.ok) return null;
  if (url.pathname.replace(/\/+$/, "") !== INVITE_PAGE_PATH) return null;
  const token = url.hash.slice(1);
  return TOKEN.test(token) ? { origin: address.origin, token } : null;
}

export const INVITE_CONTINUE_PARAM = "continue";

export function inviteJoinUrl(link: InviteLink, loginStartUrl: string): string {
  const start = new URL(loginStartUrl);
  const next = encodeURIComponent(`${start.pathname}${start.search}`);
  return `${link.origin}${INVITE_PAGE_PATH}?${INVITE_CONTINUE_PARAM}=${next}#${link.token}`;
}

export function invitePreviewBody(link: InviteLink): string {
  return JSON.stringify({ token: link.token });
}

export type InviteRefusal = "expired" | "withdrawn" | "used" | "invalid" | "busy";

export type InvitePreview =
  | {
      status: "valid";
      origin: string;
      workspace: string;
      invitedBy: string | null;
      emailHint: string;
      expiresAt: string;
    }
  | { status: InviteRefusal; origin: string };

export type InviteCheck =
  | { kind: "link" }
  | { kind: "server"; result: CheckResult }
  | { kind: "preview"; preview: InvitePreview };

const REFUSALS: Readonly<Record<string, InviteRefusal>> = {
  invite_expired: "expired",
  invite_revoked: "withdrawn",
  invite_unavailable: "withdrawn",
  invite_already_redeemed: "used",
  invite_invalid: "invalid",
  invite_credential_only: "invalid",
};

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

export function parseInvitePreview(status: number, json: unknown, origin: string): InvitePreview {
  const body = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  if (status === 429) return { status: "busy", origin };
  if (status === 200) {
    const workspace = text(body.workspace_name, 120);
    const expiresAt = text(body.expires_at, 40);
    if (!workspace || !expiresAt || Number.isNaN(Date.parse(expiresAt)))
      return { status: "invalid", origin };
    return {
      status: "valid",
      origin,
      workspace,
      invitedBy: text(body.invited_by_name, 120),
      emailHint: text(body.email_hint, 120) ?? "",
      expiresAt,
    };
  }
  const code = typeof body.code === "string" ? body.code : "";
  return { status: REFUSALS[code] ?? "invalid", origin };
}
