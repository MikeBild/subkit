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
  workflows: string[];
  workflows_omitted: number;
  connectors: string[];
  connectors_omitted: number;
  files: { name: string; slug: string | null; category: string; description: string | null }[];
  files_omitted: number;
  guides: string[];
  proposed_candidates: number;
  intake?: { collected: number; reviewing: number; proposals: number } | null;
}

export interface AgentDomains {
  domains: string[];
  from_prompt: string[];
  from_repo: string[];
  from_folder?: string[];
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

  resolveAgentDomains(
    this: EngineClient,
    params: { prompt?: string; repo?: string; folder?: string },
  ): Promise<AgentDomains> {
    return this.request("POST", "/v1/agent/domains", {
      ...(params.prompt ? { prompt: params.prompt } : {}),
      ...(params.repo ? { repo: params.repo } : {}),
      ...(params.folder ? { folder: params.folder } : {}),
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
