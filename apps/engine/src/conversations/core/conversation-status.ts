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

export function conversationSources(to: ConversationStatus): ConversationStatus[] {
  return transitionSourcesIn(CONVERSATION_TRANSITIONS, to);
}
