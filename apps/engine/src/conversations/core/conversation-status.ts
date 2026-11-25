import {
  canTransitionIn,
  type TransitionTable,
  transitionSourcesIn,
} from "@shared/transition-table.ts";
import type { ConversationStatus } from "../types.ts";

export const CONVERSATION_TRANSITIONS: TransitionTable<ConversationStatus> = {
  active: ["active", "awaiting_input", "committed", "abandoned"],
  awaiting_input: ["active", "awaiting_input", "committed", "abandoned"],
  committed: ["active", "abandoned"],
  abandoned: [],
};

export function canTransitionConversation(
  from: ConversationStatus,
  to: ConversationStatus,
): boolean {
  return canTransitionIn(CONVERSATION_TRANSITIONS, from, to);
}

export function conversationSources(
  to: ConversationStatus,
  allowed?: readonly ConversationStatus[],
): ConversationStatus[] {
  return transitionSourcesIn(CONVERSATION_TRANSITIONS, to, allowed);
}

export const CONVERSATION_ABANDONED = "conversation_abandoned";

export type ElicitationAdmission =
  | { ok: true }
  | { ok: false; reason: typeof CONVERSATION_ABANDONED };

export function canOpenElicitation(status: ConversationStatus): ElicitationAdmission {
  return status === "abandoned" ? { ok: false, reason: CONVERSATION_ABANDONED } : { ok: true };
}
