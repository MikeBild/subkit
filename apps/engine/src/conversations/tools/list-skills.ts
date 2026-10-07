import { z } from "@hono/zod-openapi";
import { listedDescription } from "../../api/catalog-metadata.ts";
import { retrieveApplicableSkills } from "../../skills/service.ts";
import { skillAudienceForAuthoringMode } from "../../skills/types.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    category: z
      .string()
      .optional()
      .describe("Only skills in this catalog block (see `category` on each skill)."),
  })
  .openapi("ListSkillsToolInput");

export const listSkillsTool: ConversationTool = {
  name: "list_skills",
  description:
    "List the skills that apply to the current conversation scope, each with what it is for (`description`) and its catalog block (`category`), which is also a filter.",
  inputSchema,
  category: "tenant_read" as const,
  permission: { action: "skill:read", resourceType: "skill" },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs ?? {});
    const skills = await retrieveApplicableSkills(
      {
        tenant_id: ctx.tenant_id,
        ...(ctx.connector_id ? { connector_ids: [ctx.connector_id] } : {}),
        ...(ctx.workflow_id ? { workflow_ids: [ctx.workflow_id] } : {}),
        audience: skillAudienceForAuthoringMode(ctx.getDraft().summary?.mode),
      },
      ctx.db,
    );
    return {
      ok: true,
      data: {
        skills: skills
          .filter((s) => args.category === undefined || s.category === args.category)
          .map((s) => ({
            id: s.id,
            title: s.title,
            description: listedDescription(s.description),
            category: s.category,
            scope: s.scope,
          })),
      },
    };
  },
};
