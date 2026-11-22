import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

type Schemas = components["schemas"];

export type SkillList = Schemas["SkillListResponse"] & { total: number };

export const skillsMethods = {
  async listSkills(
    this: EngineClient,
    query: ApiQuery<"/v1/skills", "get"> = {},
  ): Promise<SkillList> {
    const { data } = await this.api.GET("/v1/skills", { params: { query } });
    return data as SkillList;
  },

  async listMcpPrompts(this: EngineClient): Promise<Schemas["McpPromptsResponse"]> {
    const { data } = await this.api.GET("/v1/mcp/prompts");
    return data as Schemas["McpPromptsResponse"];
  },
  async listMcpResources(this: EngineClient): Promise<Schemas["McpResourcesResponse"]> {
    const { data } = await this.api.GET("/v1/mcp/resources");
    return data as Schemas["McpResourcesResponse"];
  },
  async listMcpTools(this: EngineClient): Promise<Schemas["McpToolsResponse"]> {
    const { data } = await this.api.GET("/v1/mcp/tools");
    return data as Schemas["McpToolsResponse"];
  },

  async getSkill(this: EngineClient, id: string): Promise<Schemas["Skill"]> {
    const { data } = await this.api.GET("/v1/skills/{id}", { params: { path: { id } } });
    return data as Schemas["Skill"];
  },
  async createSkill(
    this: EngineClient,
    body: ApiBody<"/v1/skills", "post">,
  ): Promise<Schemas["Skill"]> {
    const { data } = await this.api.POST("/v1/skills", { body });
    return data as Schemas["Skill"];
  },
  async patchSkill(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/skills/{id}", "patch">,
  ): Promise<Schemas["Skill"]> {
    const { data } = await this.api.PATCH("/v1/skills/{id}", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["Skill"];
  },
  async activateSkill(this: EngineClient, id: string): Promise<Schemas["Skill"]> {
    const { data } = await this.api.POST("/v1/skills/{id}/activate", { params: { path: { id } } });
    return data as Schemas["Skill"];
  },
  async archiveSkill(this: EngineClient, id: string): Promise<Schemas["Skill"]> {
    const { data } = await this.api.POST("/v1/skills/{id}/archive", { params: { path: { id } } });
    return data as Schemas["Skill"];
  },
  async deleteSkill(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/skills/{id}", { params: { path: { id } } });
  },
  async skillHistory(this: EngineClient, id: string): Promise<Schemas["SkillHistoryResponse"]> {
    const { data } = await this.api.GET("/v1/skills/{id}/history", { params: { path: { id } } });
    return data as Schemas["SkillHistoryResponse"];
  },
  async restoreSkill(
    this: EngineClient,
    id: string,
    audit_entry_id: string,
  ): Promise<Schemas["Skill"]> {
    const { data } = await this.api.POST("/v1/skills/{id}/restore", {
      params: { path: { id } },
      body: { audit_entry_id },
    });
    return data as Schemas["Skill"];
  },

  async listSkillCandidates(
    this: EngineClient,
    query: ApiQuery<"/v1/skill-candidates", "get"> = {},
  ): Promise<Schemas["SkillCandidateListResponse"]> {
    const { data } = await this.api.GET("/v1/skill-candidates", { params: { query } });
    return data as Schemas["SkillCandidateListResponse"];
  },
  async getSkillCandidate(this: EngineClient, id: string): Promise<Schemas["SkillCandidate"]> {
    const { data } = await this.api.GET("/v1/skill-candidates/{id}", { params: { path: { id } } });
    return data as Schemas["SkillCandidate"];
  },
  async approveSkillCandidate(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/skill-candidates/{id}/approve", "post"> = {},
  ): Promise<Schemas["ApproveSkillCandidateResponse"]> {
    const { data } = await this.api.POST("/v1/skill-candidates/{id}/approve", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["ApproveSkillCandidateResponse"];
  },
  async rejectSkillCandidate(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/skill-candidates/{id}/reject", "post"> = {},
  ): Promise<{ rejected: boolean }> {
    const { data } = await this.api.POST("/v1/skill-candidates/{id}/reject", {
      params: { path: { id } },
      body,
    });
    return data as { rejected: boolean };
  },
};
