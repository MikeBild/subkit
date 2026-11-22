import { app } from "electron";
import { loginCallback } from "../shared/channel.ts";
import { type InviteCheck, type InviteLink, parseInviteLink } from "../shared/invite-link.ts";
import { CHANNEL } from "./channel.ts";
import { checkServer, previewInvite } from "./server-client.ts";

const ADDRESS_MAX = 2048;

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, ADDRESS_MAX) : "";
}

export function checkAddress(raw: unknown): ReturnType<typeof checkServer> {
  return checkServer(text(raw), app.getVersion(), loginCallback(CHANNEL.scheme));
}

export function inviteLinkOf(raw: unknown): InviteLink | null {
  return parseInviteLink(text(raw));
}

export async function checkInvite(raw: unknown): Promise<InviteCheck> {
  const link = inviteLinkOf(raw);
  if (!link) return { kind: "link" };
  const check = await checkAddress(link.origin);
  if (check.result.status !== "compatible") return { kind: "server", result: check.result };
  const preview = await previewInvite(link);
  return preview
    ? { kind: "preview", preview }
    : { kind: "server", result: { ...check.result, status: "unreachable" } };
}
