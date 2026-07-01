// Guards the declarative RBAC consolidation: the migrated write tools must
// carry the exact `permission` descriptor their inline `can()` check used, and
// the central gate must allow system/unauthenticated actors (null principal),
// matching the pre-consolidation inline behaviour.

import { describe, expect, it } from "bun:test";
import { analyzeKnowledgeSourceTool } from "../generated/writes/analyze-knowledge-source.ts";
import { createKnowledgeSourceTool } from "../generated/writes/create-knowledge-source.ts";
import { createSkillTool } from "../generated/writes/create-skill.ts";
import { deleteSkillTool } from "../generated/writes/delete-skill.ts";
import { updateConnectorTool } from "../generated/writes/update-connector.ts";
import { updateKnowledgeSourceTool } from "../generated/writes/update-knowledge-source.ts";
import { updateSkillTool } from "../generated/writes/update-skill.ts";
import { updateSubscriptionTool } from "../generated/writes/update-subscription.ts";
import { updateWorkflowTool } from "../generated/writes/update-workflow.ts";
import type { ToolContext } from "../index.ts";
import { checkToolPermission } from "../permission-gate.ts";

describe("declarative RBAC descriptors on migrated write tools", () => {
  const cases: Array<{
    tool: { name: string; permission?: unknown };
    action: string;
    resourceType: string;
    resourceIdArg?: string;
  }> = [
    {
      tool: updateConnectorTool,
      action: "connector:write",
      resourceType: "connector",
      resourceIdArg: "id",
    },
    {
      tool: updateWorkflowTool,
      action: "workflow:write",
      resourceType: "workflow",
      resourceIdArg: "id",
    },
    { tool: updateSkillTool, action: "skill:write", resourceType: "skill", resourceIdArg: "id" },
    { tool: createSkillTool, action: "skill:write", resourceType: "skill" },
    { tool: deleteSkillTool, action: "skill:delete", resourceType: "skill", resourceIdArg: "id" },
    {
      tool: updateSubscriptionTool,
      action: "subscription:write",
      resourceType: "subscription",
      resourceIdArg: "id",
    },
    {
      tool: analyzeKnowledgeSourceTool,
      action: "knowledge:write",
      resourceType: "knowledge",
      resourceIdArg: "id",
    },
    {
      tool: updateKnowledgeSourceTool,
      action: "knowledge:write",
      resourceType: "knowledge",
      resourceIdArg: "id",
    },
    { tool: createKnowledgeSourceTool, action: "knowledge:write", resourceType: "knowledge" },
  ];

  for (const c of cases) {
    it(`${c.tool.name} → ${c.action} / ${c.resourceType} / ${c.resourceIdArg ?? "*"}`, () => {
      expect(c.tool.permission).toEqual({
        action: c.action,
        resourceType: c.resourceType,
        ...(c.resourceIdArg ? { resourceIdArg: c.resourceIdArg } : {}),
      });
    });
  }
});

describe("checkToolPermission — null principal (system actor) is allowed", () => {
  it("returns allow without calling can() when the actor is system", async () => {
    // engineClient.context with a system actor → resolveConversationPrincipal
    // returns null → the gate allows (system work is trusted).
    const ctx = {
      db: {} as ToolContext["db"],
      tenant_id: "t1",
      engineClient: { context: { actor_id: null, actor_type: "system" } },
    } as unknown as ToolContext;
    const result = await checkToolPermission(
      ctx,
      { action: "skill:write", resourceType: "skill", resourceIdArg: "id" },
      { id: "s1" },
    );
    expect(result.allow).toBe(true);
  });
});
