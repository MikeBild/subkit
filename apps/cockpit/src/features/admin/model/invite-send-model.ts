import type { InviteDelivery } from "@/api/invite-send";
import type { TranslationKey } from "@/lib/i18n";

export interface IssuedInvite {
  email: string;
  token: string;
  expiresAt: string;
  url?: string | null;
  note?: TranslationKey;
}

export type SendOutcome = { kind: "link"; invite: IssuedInvite } | { kind: "sent"; to: string };

const LINK_NOTE: Record<
  Extract<InviteDelivery, { delivery: "copy_link" }>["reason"],
  TranslationKey
> = {
  no_mail_transport: "people.invite.note.no_mail_transport",
  mail_failed: "people.invite.note.mail_failed",
  no_public_url: "people.invite.note.no_public_url",
};

export function sendOutcome(delivery: InviteDelivery, email: string): SendOutcome {
  if (delivery.delivery === "sent") return { kind: "sent", to: delivery.to };
  return {
    kind: "link",
    invite: {
      email,
      token: delivery.plaintext_token,
      expiresAt: delivery.invite.expires_at,
      url: delivery.url,
      note: LINK_NOTE[delivery.reason],
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function sendWaitMinutes(error: unknown): number | null {
  const failure = record(error);
  if (failure.status !== 429) return null;
  const seconds = record(failure.details).retry_after_seconds;
  return typeof seconds === "number" && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : 1;
}
