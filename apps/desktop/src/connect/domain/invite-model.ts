import type { Locale, MessageKey } from "../../shared/i18n.ts";
import {
  type InviteLink,
  type InvitePreview,
  type InviteRefusal,
  parseInviteLink,
} from "../../shared/invite-link.ts";
import { hostOf } from "../../shared/server-address.ts";

export type InviteSlot =
  | { phase: "idle" }
  | { phase: "checking"; requestId: number }
  | { phase: "invalid" };

export interface InviteField {
  open: boolean;
  link: string;
  slot: InviteSlot;
}

export const CLOSED_INVITE: InviteField = { open: false, link: "", slot: { phase: "idle" } };

export interface Invitation {
  link: InviteLink;
  preview: InvitePreview;
}

export interface WelcomeInvite {
  open: boolean;
  link: string;
  checking: boolean;
  error: MessageKey | null;
}

export function welcomeInvite(field: InviteField): WelcomeInvite {
  return {
    open: field.open,
    link: field.link,
    checking: field.slot.phase === "checking",
    error: field.slot.phase === "invalid" ? "welcome.invite.invalid" : null,
  };
}

export function inviteLinkOf(raw: string): InviteLink | null {
  return parseInviteLink(raw.slice(0, 2048));
}

export interface InviteView {
  host: string;
  valid: boolean;
  title: MessageKey;
  body: MessageKey;
  vars: Record<string, string>;
  meta: { email: string; until: string } | null;
}

const REFUSAL_TITLE: Record<InviteRefusal, MessageKey> = {
  expired: "invite.expired",
  withdrawn: "invite.withdrawn",
  used: "invite.used",
  invalid: "invite.invalid",
  busy: "invite.busy",
};

const REFUSAL_BODY: Record<InviteRefusal, MessageKey> = {
  expired: "invite.askNew",
  withdrawn: "invite.askNew",
  used: "invite.signInInstead",
  invalid: "invite.askNew",
  busy: "invite.later",
};

const DATE_LOCALE: Record<Locale, string> = { de: "de-DE", en: "en-US" };

export function untilDate(iso: string, locale: Locale): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Intl.DateTimeFormat(DATE_LOCALE[locale], {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(at);
}

export function inviteView(invitation: Invitation, locale: Locale): InviteView {
  const { preview } = invitation;
  const host = hostOf(preview.origin);
  if (preview.status !== "valid") {
    return {
      host,
      valid: false,
      title: REFUSAL_TITLE[preview.status],
      body: REFUSAL_BODY[preview.status],
      vars: {},
      meta: null,
    };
  }
  return {
    host,
    valid: true,
    title: "invite.valid",
    body: preview.invitedBy ? "invite.valid.body" : "invite.valid.anonymous",
    vars: { inviter: preview.invitedBy ?? "", workspace: preview.workspace },
    meta: preview.emailHint
      ? { email: preview.emailHint, until: untilDate(preview.expiresAt, locale) }
      : null,
  };
}
