import type { AuthoringPromptHint } from "../../llm/types.ts";

export type ConversationSurface = "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";

export interface AgentSystemPromptInput {
  surface?: ConversationSurface;
  authoring_hint?: AuthoringPromptHint;
}

export interface AgentSystemPromptResult {
  content: string;
  volatile?: string;
}
