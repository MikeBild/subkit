// Agent registry types. Kept in their own module so `registry.ts`,
// `context.ts`, and the loop wiring all reference the same shapes
// without circular imports.

import type { AuthoringPromptHint } from "../../llm/types.ts";
import type { AgentSkillName } from "./skills/index.ts";

export type ConversationSurface = "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";

/** Inputs the system-prompt generator needs from the conversation loop. */
export interface AgentSystemPromptInput {
  surface?: ConversationSurface;
  authoring_hint?: AuthoringPromptHint;
}

export interface AgentSystemPromptResult {
  /** The fully composed system prompt body. */
  content: string;
}

export interface AgentDefinition {
  id: string;
  /** Skill bodies preloaded into every prompt for this agent. */
  preloadedSkills: ReadonlyArray<AgentSkillName>;
  /** Pure-async generator that returns the per-turn system prompt body. */
  systemPromptGenerator: (input: AgentSystemPromptInput) => Promise<AgentSystemPromptResult>;
}
