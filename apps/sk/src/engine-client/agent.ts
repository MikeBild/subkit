// External-coding-agent surfaces of the engine client: the SessionStart
// briefing. Method group merged into `EngineClient` by `../engine-client.ts`.

import type { EngineClient } from "../engine-client.ts";

export interface AgentBriefing {
  markdown: string;
  domains: string[];
  budget_tokens: number;
  used_tokens: number;
  skills_full: string[];
  skills_title_only: string[];
  knowledge_sources: string[];
  knowledge_sources_omitted: number;
  proposed_candidates: number;
}

export const agentMethods = {
  getAgentBriefing(
    this: EngineClient,
    params: { domains: string[]; budget_tokens?: number },
  ): Promise<AgentBriefing> {
    return this.request("GET", "/v1/agent/briefing", undefined, {
      domains: params.domains.join(","),
      ...(params.budget_tokens !== undefined ? { budget_tokens: params.budget_tokens } : {}),
    });
  },

  captureAgentSession(
    this: EngineClient,
    body: {
      agent: string;
      session_id?: string;
      repo?: string;
      domains: string[];
      transcript: string;
    },
  ): Promise<{ queued: boolean; transcript_chars: number }> {
    return this.request("POST", "/v1/agent/sessions", body);
  },
};
