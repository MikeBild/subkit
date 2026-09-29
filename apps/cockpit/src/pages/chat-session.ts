import type { ConversationReference, UiMessage } from "@/api/client";

// What keeps the conversation still while a turn is sent.
//
// After a send the page used to jump three times: the request appeared as a
// dark bubble on the right, vanished when the turn ended, and came back as the
// light "Du" bubble on the left after a gap — and the transcript and composer
// remounted, because they were keyed on the conversation id, which changes
// from "new" to the created id in the middle of the first send. These are the
// rules that replace it, kept pure so a test can hold each one.

/**
 * How the reader arrived at what they are looking at. Only a deliberate move
 * — a new conversation, a pick from the list, the browser's back/forward —
 * starts a new session. The address rewrite after the first send (`/chat/new`
 * becomes `/chat/<id>`) is the same conversation continuing, not a new one.
 */
export type ChatNavigation = "startNew" | "select" | "popstate" | "firstSendSaved";

/** The key the transcript and composer are mounted under. */
export function nextSessionKey(key: number, navigation: ChatNavigation): number {
  return navigation === "firstSendSaved" ? key : key + 1;
}

/** A request the reader sent that the engine has not yet handed back as saved. */
export interface OptimisticMessage {
  session: number;
  text: string;
  references: ConversationReference[];
  /** User messages the conversation held when this one was sent. */
  baseline: number;
  sentAt: string;
}

export function userMessageCount(messages: readonly Pick<UiMessage, "role">[]): number {
  return messages.filter((message) => message.role === "user").length;
}

/**
 * Whether the pending request still needs its stand-in. It stays until the
 * saved one is in the transcript — a count past the baseline, not a text
 * comparison, because the engine may store the text scrubbed — so there is no
 * moment in which the request is on screen nowhere.
 */
export function optimisticVisible(
  optimistic: OptimisticMessage | null,
  session: number,
  messages: readonly Pick<UiMessage, "role">[],
): boolean {
  if (!optimistic || optimistic.session !== session) return false;
  return userMessageCount(messages) <= optimistic.baseline;
}

/**
 * After a failed send: give the text back to the composer only if the engine
 * did not keep it. A stopped or half-failed turn may still have stored the
 * request; putting it back then invites sending it twice.
 */
export function shouldRestoreComposer(
  optimistic: Pick<OptimisticMessage, "baseline">,
  messagesAfter: readonly Pick<UiMessage, "role">[],
): boolean {
  return userMessageCount(messagesAfter) <= optimistic.baseline;
}

/** The stand-in, in the shape a saved request has, so its chips render the same. */
export function optimisticUiMessage(optimistic: OptimisticMessage): UiMessage {
  return {
    id: `optimistic-${optimistic.session}-${optimistic.baseline}`,
    role: "user",
    parts: [
      {
        type: "text",
        text: optimistic.text,
        ...(optimistic.references.length > 0 ? { references: optimistic.references } : {}),
      },
    ],
    model: null,
    created_at: optimistic.sentAt,
  };
}

/**
 * The header's title, which must not flicker while a conversation loads.
 *
 * A conversation begun here reads "Neue Unterhaltung" until the engine names
 * it; it no longer passes through "Unbenannte Unterhaltung" on the way. One
 * opened from the list or an address reads the list's title while its detail
 * loads, and "Unbenannt" only once it has loaded and really has none.
 */
export function chatHeaderTitle(input: {
  title: string | null | undefined;
  listTitle: string | null | undefined;
  failed: boolean;
  activeId: string | null;
  startedHere: boolean;
  loaded: boolean;
}): { kind: "title"; text: string } | { kind: "new" | "untitled" | "unavailable" | "loading" } {
  if (input.title) return { kind: "title", text: input.title };
  if (input.listTitle) return { kind: "title", text: input.listTitle };
  if (input.failed) return { kind: "unavailable" };
  if (!input.activeId || input.startedHere) return { kind: "new" };
  return input.loaded ? { kind: "untitled" } : { kind: "loading" };
}

/** A token count only where there is one: the convention allows no bare zero. */
export function tokenPill(usage: { tokens: number } | null | undefined): number | null {
  return usage && usage.tokens > 0 ? usage.tokens : null;
}

/** Money only where a rate covered a call; a floor where some did not. */
export function costPill(
  usage:
    | { cost: { amount: number; currency: string; unpriced_models: string[] } | null }
    | null
    | undefined,
): { amount: number; currency: string; floor: boolean } | null {
  const cost = usage?.cost;
  if (!cost) return null;
  return { amount: cost.amount, currency: cost.currency, floor: cost.unpriced_models.length > 0 };
}

/** The month's allowance, only when it asks for attention. */
export function budgetPill(
  state: "ample" | "tightening" | "critical" | null | undefined,
): "tightening" | "critical" | null {
  return state === "tightening" || state === "critical" ? state : null;
}
