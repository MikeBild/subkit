// Skills surfaces of the engine client: skill CRUD + lifecycle +
// history, skill candidates, and the MCP catalog listings (prompts are
// backed by skills; resources/tools complete the catalog picture).
// Method group merged into `EngineClient` by `../engine-client.ts`.

import type { EngineClient } from "../engine-client.ts";

export const skillsMethods = {
  // --------------------------- Skills ---------------------------
  listSkills(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Array<{ id: string; title: string; scope: string }> }> {
    return this.request("GET", "/v1/skills", undefined, query);
  },

  // --------------------------- MCP catalog ---------------------------
  listMcpPrompts(this: EngineClient): Promise<{
    items: Array<{ name: string; description: string | null; scope: string; skill_id: string }>;
  }> {
    return this.request("GET", "/v1/mcp/prompts");
  },
  listMcpResources(this: EngineClient): Promise<{
    items: Array<{
      uri: string;
      name: string;
      description: string | null;
      mime_type: string | null;
    }>;
  }> {
    return this.request("GET", "/v1/mcp/resources");
  },
  listMcpTools(this: EngineClient): Promise<{
    items: Array<{ name: string; description: string; input_shape: unknown }>;
  }> {
    return this.request("GET", "/v1/mcp/tools");
  },

  // -------------------- Skills --------------------
  getSkill(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/skills/${encodeURIComponent(id)}`);
  },
  createSkill(this: EngineClient, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/skills", body);
  },
  patchSkill(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/skills/${encodeURIComponent(id)}`, body);
  },
  activateSkill(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/skills/${encodeURIComponent(id)}/activate`);
  },
  archiveSkill(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/skills/${encodeURIComponent(id)}/archive`);
  },
  deleteSkill(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/skills/${encodeURIComponent(id)}`);
  },
  skillHistory(this: EngineClient, id: string): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", `/v1/skills/${encodeURIComponent(id)}/history`);
  },
  restoreSkill(
    this: EngineClient,
    id: string,
    audit_entry_id: string,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/skills/${encodeURIComponent(id)}/restore`, {
      audit_entry_id,
    });
  },

  // -------------------- Skill Candidates --------------------
  listSkillCandidates(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    return this.request("GET", "/v1/skill-candidates", undefined, query);
  },
  getSkillCandidate(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/skill-candidates/${encodeURIComponent(id)}`);
  },
  approveSkillCandidate(
    this: EngineClient,
    id: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/skill-candidates/${encodeURIComponent(id)}/approve`, body);
  },
  rejectSkillCandidate(
    this: EngineClient,
    id: string,
    body: { reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/skill-candidates/${encodeURIComponent(id)}/reject`, body);
  },
};
