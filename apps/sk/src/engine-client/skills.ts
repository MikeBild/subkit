import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

export const skillsMethods = {
  async listSkills(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Array<{ id: string; title: string; scope: string }> }> {
    const { data } = await this.api.GET("/v1/skills", {
      params: { query: query as ApiQuery<"/v1/skills", "get"> },
    });
    return data as { items: Array<{ id: string; title: string; scope: string }> };
  },

  async listMcpPrompts(this: EngineClient): Promise<{
    items: Array<{ name: string; description: string | null; scope: string; skill_id: string }>;
  }> {
    const { data } = await this.api.GET("/v1/mcp/prompts");
    return data as {
      items: Array<{ name: string; description: string | null; scope: string; skill_id: string }>;
    };
  },
  async listMcpResources(this: EngineClient): Promise<{
    items: Array<{
      uri: string;
      name: string;
      description: string | null;
      mime_type: string | null;
    }>;
  }> {
    const { data } = await this.api.GET("/v1/mcp/resources");
    return data as {
      items: Array<{
        uri: string;
        name: string;
        description: string | null;
        mime_type: string | null;
      }>;
    };
  },
  async listMcpTools(this: EngineClient): Promise<{
    items: Array<{ name: string; description: string; input_shape: unknown }>;
  }> {
    const { data } = await this.api.GET("/v1/mcp/tools");
    return data as {
      items: Array<{ name: string; description: string; input_shape: unknown }>;
    };
  },

  async getSkill(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/skills/{id}", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  async createSkill(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/skills", {
      body: body as ApiBody<"/v1/skills", "post">,
    });
    return data as Record<string, unknown>;
  },
  async patchSkill(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.PATCH("/v1/skills/{id}", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/skills/{id}", "patch">,
    });
    return data as Record<string, unknown>;
  },
  async activateSkill(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/skills/{id}/activate", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  async archiveSkill(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/skills/{id}/archive", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  async deleteSkill(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/skills/{id}", { params: { path: { id } } });
  },
  async skillHistory(
    this: EngineClient,
    id: string,
  ): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/skills/{id}/history", { params: { path: { id } } });
    return data as { items: Record<string, unknown>[] };
  },
  async restoreSkill(
    this: EngineClient,
    id: string,
    audit_entry_id: string,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/skills/{id}/restore", {
      params: { path: { id } },
      body: {
        audit_entry_id,
      } as ApiBody<"/v1/skills/{id}/restore", "post">,
    });
    return data as Record<string, unknown>;
  },

  async listSkillCandidates(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const { data } = await this.api.GET("/v1/skill-candidates", {
      params: { query: query as ApiQuery<"/v1/skill-candidates", "get"> },
    });
    return data as { items: Record<string, unknown>[]; total: number };
  },
  async getSkillCandidate(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/skill-candidates/{id}", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  async approveSkillCandidate(
    this: EngineClient,
    id: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/skill-candidates/{id}/approve", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/skill-candidates/{id}/approve", "post">,
    });
    return data as Record<string, unknown>;
  },
  async rejectSkillCandidate(
    this: EngineClient,
    id: string,
    body: { reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/skill-candidates/{id}/reject", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/skill-candidates/{id}/reject", "post">,
    });
    return data as Record<string, unknown>;
  },
};
