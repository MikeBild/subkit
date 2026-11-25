import type { ChatEvent } from "./types.ts";

export function chatThreadVisibility(
  ev: Pick<ChatEvent, "platform" | "channel_id" | "is_direct_message">,
): "private" | "team" {
  if (ev.is_direct_message === true) return "private";
  if (ev.platform === "slack" && /^[DG]/.test(ev.channel_id)) return "private";
  return "team";
}
