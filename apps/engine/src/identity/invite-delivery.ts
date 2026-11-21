import { INVITE_PAGE_PATH } from "./membership-invite.ts";

export interface InviteMail {
  readonly to: string;
  readonly workspace: string;
  readonly inviter: string;
  readonly url: string;
  readonly expires_at: Date;
}

export interface InviteMailTransport {
  readonly channel: "email";
  send(mail: InviteMail): Promise<{ readonly ok: true } | { readonly ok: false }>;
}

export type InviteDeliveryOutcome =
  | { readonly delivery: "sent"; readonly channel: "email" }
  | {
      readonly delivery: "copy_link";
      readonly reason: "no_mail_transport" | "mail_failed" | "no_public_url";
    };

let transport: InviteMailTransport | null = null;

export function inviteMailTransport(): InviteMailTransport | null {
  return transport;
}

export function useInviteMailTransport(next: InviteMailTransport | null): void {
  transport = next;
}

export function inviteLinkPath(plaintext: string): string {
  return `${INVITE_PAGE_PATH}#${plaintext}`;
}

export function inviteUrl(origin: string | null, plaintext: string): string | null {
  return origin ? `${origin.replace(/\/+$/u, "")}${inviteLinkPath(plaintext)}` : null;
}

export async function deliverInvite(
  mailer: InviteMailTransport | null,
  mail: Omit<InviteMail, "url"> & { readonly url: string | null },
): Promise<InviteDeliveryOutcome> {
  if (!mailer) return { delivery: "copy_link", reason: "no_mail_transport" };
  if (!mail.url) return { delivery: "copy_link", reason: "no_public_url" };
  try {
    const sent = await mailer.send({ ...mail, url: mail.url });
    return sent.ok
      ? { delivery: "sent", channel: mailer.channel }
      : { delivery: "copy_link", reason: "mail_failed" };
  } catch {
    return { delivery: "copy_link", reason: "mail_failed" };
  }
}
