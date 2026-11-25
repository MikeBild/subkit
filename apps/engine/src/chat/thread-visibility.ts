import type { ChatEvent } from "./types.ts";

/**
 * Threads in Slack or Google Chat channels are shared with the team; direct
 * messages stay private. Slack direct-message channel IDs start with "D".
 */
export function chatThreadVisibility(
  ev: Pick<ChatEvent, "platform" | "channel_id" | "is_direct_message">,
): "private" | "team" {
  if (ev.is_direct_message === true) return "private";
  if (ev.platform === "slack" && ev.channel_id.startsWith("D")) return "private";
  return "team";
}
