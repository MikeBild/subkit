import { describe, expect, it } from "bun:test";
import { callConnectorTool } from "../call-connector.ts";
import { analyzeKnowledgeSourceTool } from "../engine-api/writes/analyze-knowledge-source.ts";
import {
  deleteConnectorTool,
  deleteKnowledgeSourceTool,
  deleteSubscriptionTool,
  deleteWorkflowTool,
  revokeApiKeyTool,
  revokePortalTokenTool,
} from "../engine-api/writes/cleanup.ts";
import { createKnowledgeSourceTool } from "../engine-api/writes/create-knowledge-source.ts";
import { deleteSkillTool } from "../engine-api/writes/delete-skill.ts";
import { updateConnectorTool } from "../engine-api/writes/update-connector.ts";
import { updateKnowledgeSourceTool } from "../engine-api/writes/update-knowledge-source.ts";
import { updateSkillTool } from "../engine-api/writes/update-skill.ts";
import { updateSubscriptionTool } from "../engine-api/writes/update-subscription.ts";
import { updateWorkflowTool } from "../engine-api/writes/update-workflow.ts";
import type { ToolContext } from "../index.ts";
import { checkToolPermission } from "../permission-gate.ts";
import { requestConnectorReauthTool } from "../request-connector-reauth.ts";
import { restoreWorkflowVersionTool } from "../restore-workflow-version.ts";

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
    expect(denied).toEqual({
      ok: false,
      data: { error: { code: "permission_denied", message: "nope" }, permission: "connector:read" },
    });
  });

  it("request_connector_reauth uses a resolver + top-level error_code denyResult", () => {
    expect(requestConnectorReauthTool.permission?.action).toBe("connector:write");
    expect(typeof requestConnectorReauthTool.permission?.resolveResourceId).toBe("function");
    const denied = requestConnectorReauthTool.permission?.denyResult?.("connector:write", "nope");
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

describe("save_learning collects into intake under skill:propose", () => {
  it("keeps the coding-agent hook permission on the dispatcher path", async () => {
    const { conversationToolProvider } = await import("../../../tools/providers/conversation.ts");
    const descriptor = conversationToolProvider
      .list({ surface: "mcp", mcpMode: "admin" })
      .find((d) => d.name === "save_learning");
    expect(descriptor?.rbac?.permission).toBe("skill:propose");
  });
});

describe("restore_workflow_version carries a permission gate, not just a confirm gate", () => {
  it("declares workflow:restore on the workflow resource", () => {
    expect(restoreWorkflowVersionTool.permission?.action).toBe("workflow:restore");
    expect(restoreWorkflowVersionTool.permission?.resourceType).toBe("workflow");
  });

  it("is also gated on the dispatcher path (MCP/admin), not only the LLM path", async () => {
    const { conversationToolProvider } = await import("../../../tools/providers/conversation.ts");
    const descriptor = conversationToolProvider
      .list({ surface: "mcp", mcpMode: "admin" })
      .find((d) => d.name === "restore_workflow_version");
    expect(descriptor).toBeDefined();
    expect(descriptor?.rbac?.permission).toBe("workflow:restore");
  });

  it("resolves the id rather than gating on a slug", () => {
    expect(typeof restoreWorkflowVersionTool.permission?.resolveResourceId).toBe("function");
    expect(restoreWorkflowVersionTool.permission?.resourceIdArg).toBeUndefined();
  });

  describe("resolveResourceId", () => {
    const resolve = restoreWorkflowVersionTool.permission?.resolveResourceId;
    const dbReturning = (rows: Array<{ id: string }>) =>
      ({
        db: {
          select: () => ({
            from: () => ({ where: () => ({ limit: async () => rows }) }),
          }),
        },
        tenant_id: "t1",
      }) as unknown as ToolContext;

    it("uses workflow_id verbatim when present (no lookup)", async () => {
      const ctx = {
        db: {
          select: () => {
            throw new Error("must not be called");
          },
        },
        tenant_id: "t1",
      } as unknown as ToolContext;
      expect(await resolve?.(ctx, { workflow_id: "wf-uuid-1", version: 1 })).toBe("wf-uuid-1");
    });

    it("resolves slug → workflow id", async () => {
      expect(
        await resolve?.(dbReturning([{ id: "wf-uuid-2" }]), { slug: "invoice-sync", version: 1 }),
      ).toBe("wf-uuid-2");
    });

    it("returns null for an unknown slug so the gate defers to workflow_not_found", async () => {
      expect(await resolve?.(dbReturning([]), { slug: "ghost", version: 1 })).toBeNull();
    });

    it("returns null when neither identifier is supplied", async () => {
      const ctx = { tenant_id: "t1" } as unknown as ToolContext;
      expect(await resolve?.(ctx, { version: 1 })).toBeNull();
    });
  });
});

describe("checkToolPermission — null principal (system actor) is allowed", () => {
  it("returns allow without calling can() when the actor is system", async () => {
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
