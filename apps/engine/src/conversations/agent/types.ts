import type { AuthoringPromptHint } from "../../llm/types.ts";
import type { AgentSkillName } from "./skills/index.ts";

export type ConversationSurface = "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";

export interface AgentSystemPromptInput {
  surface?: ConversationSurface;
  authoring_hint?: AuthoringPromptHint;
}

export interface AgentSystemPromptResult {
  content: string;
  volatile?: string;
}

export interface AgentDefinition {
  id: string;
  preloadedSkills: ReadonlyArray<AgentSkillName>;
  systemPromptGenerator: (input: AgentSystemPromptInput) => Promise<AgentSystemPromptResult>;
}
