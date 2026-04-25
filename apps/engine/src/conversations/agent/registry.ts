// Agent registry — maps an agent type to its behaviour bundle:
// preloaded skills + system prompt generator. Currently subkit ships
// one agent (`MAIN`); the registry leaves room for `EXECUTION_REPAIR`
// or `AUTHORING_PLAYGROUND` variants without rewriting the loop.
//
// Mirrors the reference codebase's `agent-registry.ts` 1:1 in shape.

import { generateMainAgentSystemPrompt } from "./context.ts";
import { type AgentSkillName, ALL_AGENT_SKILLS } from "./skills/index.ts";
import type { AgentDefinition, AgentSystemPromptInput, AgentSystemPromptResult } from "./types.ts";

export enum AgentType {
  MAIN = "main",
}

export const AGENT_REGISTRY: Record<AgentType, AgentDefinition> = {
  [AgentType.MAIN]: {
    id: AgentType.MAIN,
    preloadedSkills: ALL_AGENT_SKILLS,
    systemPromptGenerator: generateMainAgentSystemPrompt,
  },
};

export function getAgent(agentId: AgentType): AgentDefinition {
  const agent = AGENT_REGISTRY[agentId];
  if (!agent) {
    throw new Error(`Unknown agent: ${agentId}. Available: ${Object.values(AgentType).join(", ")}`);
  }
  return agent;
}

export type { AgentDefinition, AgentSkillName, AgentSystemPromptInput, AgentSystemPromptResult };
