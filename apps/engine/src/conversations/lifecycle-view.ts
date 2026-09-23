// What a conversation has come to, as a reader would say it.
//
// `conversations.status` describes the authoring state machine (active,
// awaiting_input, committed, abandoned) and nothing in it changes when a
// question is simply answered — which is why every list row used to read
// "active" forever. The outcome below is a projection over the status and the
// last message; it is computed at read time, never stored, so there is no
// second state machine to keep in step with the first.

export type ConversationOutcome =
  /** The last thing that happened is an assistant answer; nothing is pending. */
  | "answered"
  /** A person's message or a tool result is the last row and the turn is still running. */
  | "in_progress"
  /** The last turn stopped because something broke, and said why. */
  | "failed"
  /** A pending elicitation waits for the reader (status `awaiting_input`). */
  | "awaiting_you"
  | "committed"
  | "abandoned"
  /** Answered, but nobody touched it for `STALE_AFTER_DAYS` days. */
  | "stale";

export const STALE_AFTER_DAYS = 7;

export interface OutcomeInput {
  status: string;
  last_message_role: string | null;
  /** ISO time of the newest message, or null for an empty conversation. */
  last_activity_at: string | null;
  /** Why the last turn stopped, when it stopped because something broke. */
  last_turn_error?: { code: string; message: string; at: string } | null | undefined;
  now: number;
}

export function deriveConversationOutcome(input: OutcomeInput): ConversationOutcome {
  if (input.status === "committed") return "committed";
  if (input.status === "abandoned") return "abandoned";
  if (input.status === "awaiting_input") return "awaiting_you";
  // A turn that died wrote no message, so without this it reads "in progress"
  // for as long as anyone looks — the shape a provider quota takes, and
  // indistinguishable from a turn still thinking.
  if (input.last_turn_error) return "failed";
  if (input.last_message_role !== "assistant") return "in_progress";
  if (input.last_activity_at) {
    const age = input.now - Date.parse(input.last_activity_at);
    if (age > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000) return "stale";
  }
  return "answered";
}

/** Surfaces a conversation can be opened from. Persisted on the row at create. */
export const CONVERSATION_SURFACES = [
  "web",
  "sk_interactive",
  "sk_headless",
  "mcp",
  "chat",
  "api",
] as const;
export type ConversationSurface = (typeof CONVERSATION_SURFACES)[number];

/**
 * The surface an HTTP caller opened a conversation from. The Cockpit
 * identifies itself with a header; sk sends its mode; anything else is the
 * bare API. Never guessed from the credential — a browser session and an API
 * key can both drive the same route.
 */
export function surfaceFromClientHeader(value: string | undefined | null): ConversationSurface {
  switch ((value ?? "").trim().toLowerCase()) {
    case "cockpit":
      return "web";
    case "sk":
    case "sk_interactive":
      return "sk_interactive";
    case "sk_headless":
      return "sk_headless";
    default:
      return "api";
  }
}
