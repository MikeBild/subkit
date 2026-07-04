// Guards the declarative RBAC consolidation: the migrated write tools must
// carry the exact `permission` descriptor their inline `can()` check used, and
// the central gate must allow system/unauthenticated actors (null principal),
// matching the pre-consolidation inline behaviour.

import { describe, expect, it } from "bun:test";
import { callConnectorTool } from "../call-connector.ts";
import { analyzeKnowledgeSourceTool } from "../generated/writes/analyze-knowledge-source.ts";
import {
  deleteConnectorTool,
  deleteKnowledgeSourceTool,
  deleteSubscriptionTool,
  deleteWorkflowTool,
  revokeApiKeyTool,
  revokePortalTokenTool,
} from "../generated/writes/cleanup.ts";
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
import { requestConnectorReauthTool } from "../request-connector-reauth.ts";

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

describe("declarative RBAC descriptors on the migrated hold-out tools", () => {
  const simple: Array<{
    tool: {
      name: string;
      permission?: { action: string; resourceType: string; resourceIdArg?: string };
    };
    action: string;
    resourceType: string;
    resourceIdArg?: string;
  }> = [
    {
      tool: deleteConnectorTool,
      action: "connector:delete",
      resourceType: "connector",
      resourceIdArg: "id",
    },
    {
      tool: deleteKnowledgeSourceTool,
      action: "knowledge:delete",
      resourceType: "knowledge_source",
      resourceIdArg: "id",
    },
    {
      tool: deleteSubscriptionTool,
      action: "subscription:delete",
      resourceType: "subscription",
      resourceIdArg: "id",
    },
    {
      tool: revokeApiKeyTool,
      action: "api_key:revoke",
      resourceType: "api_key",
      resourceIdArg: "id",
    },
    {
      tool: revokePortalTokenTool,
      action: "portal_token:revoke",
      resourceType: "portal_token",
      resourceIdArg: "id",
    },
  ];
  for (const c of simple) {
    it(`${c.tool.name} → ${c.action} / ${c.resourceType} / ${c.resourceIdArg}`, () => {
      expect(c.tool.permission?.action).toBe(c.action);
      expect(c.tool.permission?.resourceType).toBe(c.resourceType);
      expect(c.tool.permission?.resourceIdArg).toBe(c.resourceIdArg);
    });
  }

  it("call_connector uses connector:read + a bespoke denyResult (nested error contract)", () => {
    expect(callConnectorTool.permission?.action).toBe("connector:read");
    expect(callConnectorTool.permission?.resourceIdArg).toBe("connector_id");
    const denied = callConnectorTool.permission?.denyResult?.("connector:read", "nope");
    // call_connector's structuredError nests error as {code,message}.
    expect(denied).toEqual({
      ok: false,
      data: { error: { code: "permission_denied", message: "nope" }, permission: "connector:read" },
    });
  });

  it("request_connector_reauth uses a resolver + top-level error_code denyResult", () => {
    expect(requestConnectorReauthTool.permission?.action).toBe("connector:write");
    expect(typeof requestConnectorReauthTool.permission?.resolveResourceId).toBe("function");
    const denied = requestConnectorReauthTool.permission?.denyResult?.("connector:write", "nope");
    // its structuredError is the top-level {error_code, message} form; the
    // extra `permission` rides along at runtime (not part of the ToolResult type).
    expect(denied as Record<string, unknown>).toEqual({
      ok: false,
      error_code: "permission_denied",
      message: "nope",
      permission: "connector:write",
    });
  });
});

describe("delete_workflow resolveResourceId — resolves the UUID before can()", () => {
  const resolve = deleteWorkflowTool.permission?.resolveResourceId;

  it("uses args.id verbatim when present (no lookup)", async () => {
    const ctx = {
      engineClient: {
        workflows: {
          getBySlug: async () => {
            throw new Error("must not be called");
          },
        },
      },
    } as unknown as ToolContext;
    expect(await resolve?.(ctx, { id: "wf-uuid-1" })).toBe("wf-uuid-1");
  });

  it("resolves slug → workflow.id via getBySlug", async () => {
    const ctx = {
      engineClient: {
        workflows: { getBySlug: async (s: string) => (s === "my-wf" ? { id: "wf-uuid-2" } : null) },
      },
    } as unknown as ToolContext;
    expect(await resolve?.(ctx, { slug: "my-wf" })).toBe("wf-uuid-2");
  });

  it("returns null when the slug does not resolve (gate defers to the tool's not_found)", async () => {
    const ctx = {
      engineClient: { workflows: { getBySlug: async () => null } },
    } as unknown as ToolContext;
    expect(await resolve?.(ctx, { slug: "ghost" })).toBeNull();
  });
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
