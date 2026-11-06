import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

interface AgentBriefing {
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
  intake?: { clips: number; sessions: number; proposals: number } | null;
}

interface AgentDomains {
  domains: string[];
  from_prompt: string[];
  from_repo: string[];
  from_folder?: string[];
}

export const agentMethods = {
  async getAgentBriefing(
    this: EngineClient,
    params: { domains: string[]; budget_tokens?: number },
  ): Promise<AgentBriefing> {
    const query = {
      domains: params.domains.join(","),
      ...(params.budget_tokens !== undefined ? { budget_tokens: params.budget_tokens } : {}),
    } as ApiQuery<"/v1/agent/briefing", "get">;
    const { data } = await this.api.GET("/v1/agent/briefing", { params: { query } });
    return data as AgentBriefing;
  },

  async resolveAgentDomains(
    this: EngineClient,
    params: { prompt?: string; repo?: string; folder?: string },
  ): Promise<AgentDomains> {
    const body = {
      ...(params.prompt ? { prompt: params.prompt } : {}),
      ...(params.repo ? { repo: params.repo } : {}),
      ...(params.folder ? { folder: params.folder } : {}),
    } as ApiBody<"/v1/agent/domains", "post">;
    const { data } = await this.api.POST("/v1/agent/domains", { body });
    return data as AgentDomains;
  },

  async captureAgentSession(
    this: EngineClient,
    body: {
      agent: string;
      session_id?: string;
      repo?: string;
      domains: string[];
      transcript: string;
    },
  ): Promise<{ queued: boolean; transcript_chars: number }> {
    const { data } = await this.api.POST("/v1/agent/sessions", {
      body: body as ApiBody<"/v1/agent/sessions", "post">,
    });
    return data as { queued: boolean; transcript_chars: number };
  },
};
