export type ConversationOutcome =
  | "answered"
  | "in_progress"
  | "failed"
  | "awaiting_you"
  | "committed"
  | "abandoned"
  | "stale";

export const STALE_AFTER_DAYS = 7;

interface OutcomeInput {
  status: string;
  last_message_role: string | null;
  last_activity_at: string | null;
  last_turn_error?:
    | { code: string; message: string; at: string; kind?: string; retry_at?: string }
    | null
    | undefined;
  now: number;
}

export function deriveConversationOutcome(input: OutcomeInput): ConversationOutcome {
  if (input.status === "committed") return "committed";
  if (input.status === "abandoned") return "abandoned";
  if (input.status === "awaiting_input") return "awaiting_you";
  if (input.last_turn_error) return "failed";
  if (input.last_message_role !== "assistant") return "in_progress";
  if (input.last_activity_at) {
    const age = input.now - Date.parse(input.last_activity_at);
    if (age > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000) return "stale";
  }
  return "answered";
}

export const CONVERSATION_SURFACES = [
  "web",
  "sk_interactive",
  "sk_headless",
  "mcp",
  "chat",
  "api",
] as const;
export type ConversationSurface = (typeof CONVERSATION_SURFACES)[number];

export function surfaceFromClientHeader(value: string | undefined | null): ConversationSurface {
  switch ((value ?? "").trim().toLowerCase()) {
    case "cockpit":
      return "web";
    case "subkit":
    case "sk_interactive":
      return "sk_interactive";
    case "sk_headless":
      return "sk_headless";
    default:
      return "api";
  }
}

export function turnSurfaceFromClientHeader(
  value: string | undefined | null,
): Exclude<ConversationSurface, "api"> | undefined {
  const surface = surfaceFromClientHeader(value);
  return surface === "api" ? undefined : surface;
}
