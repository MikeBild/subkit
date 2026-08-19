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
  /**
   * The per-turn slice of the prompt (the authoring-focus block).
   *
   * Kept out of `content` so the assembler can render it behind the cache
   * breakpoint: it names the current stage and next action, so leaving it in
   * the body invalidated the cached prefix once per turn.
   */
  volatile?: string;
}

export interface AgentDefinition {
  id: string;
  /** Skill bodies preloaded into every prompt for this agent. */
  preloadedSkills: ReadonlyArray<AgentSkillName>;
  /** Pure-async generator that returns the per-turn system prompt body. */
  systemPromptGenerator: (input: AgentSystemPromptInput) => Promise<AgentSystemPromptResult>;
}
