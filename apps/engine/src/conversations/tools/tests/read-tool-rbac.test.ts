import { describe, expect, it, test } from "bun:test";
import { AuditAction } from "../../../audit/types.ts";
import { dispatchTool } from "../../../tools/dispatcher.ts";
import { conversationToolProvider } from "../../../tools/providers/conversation.ts";
import { buildRegistry } from "../../../tools/registry.ts";
import { makeStubDb, makeTestPrincipal, usePolicyFixture } from "../../../tools/tests/_helpers.ts";
import type { ToolDescriptor } from "../../../tools/types.ts";
import { getConnectorTool, listConnectorsTool } from "../engine-api/connectors.ts";
import { getExecutionTool } from "../engine-api/executions.ts";
import {
  getApiKeyTool,
  getUserTool,
  listApiKeysTool,
  listPortalTokensTool,
  listSystemAccountsTool,
  listUsersTool,
  whoamiTool,
} from "../engine-api/identity.ts";
import {
  getKnowledgeSourceTool,
  listKnowledgeSourcesTool,
  readKnowledgeTool,
} from "../engine-api/knowledge-sources.ts";
import { getSkillTool, listAllSkillsTool } from "../engine-api/skills.ts";
import { getStatusSummaryTool } from "../engine-api/status.ts";
import { listSchedulesTool } from "../engine-api/writes/schedules.ts";
import { findConnectorTool } from "../find-connector.ts";
import { listCapabilityGapsTool } from "../list-capability-gaps.ts";
import { listSkillsTool } from "../list-skills.ts";
import { reviewWorkflowAutomationTool } from "../review-workflow-automation.ts";

usePolicyFixture();

type PermCase = {
  tool: {
    name: string;
    permission?: { action: string; resourceType: string; resourceIdArg?: string };
  };
  action: string;
  resourceType: string;
  resourceIdArg?: string;
};

const GATED: PermCase[] = [
  { tool: reviewWorkflowAutomationTool, action: "schedule:read", resourceType: "schedule" },
  { tool: listAllSkillsTool, action: "skill:read", resourceType: "skill" },
  { tool: getSkillTool, action: "skill:read", resourceType: "skill", resourceIdArg: "id" },
  { tool: listSkillsTool, action: "skill:read", resourceType: "skill" },
  { tool: listKnowledgeSourcesTool, action: "knowledge:read", resourceType: "knowledge" },
  {
    tool: getKnowledgeSourceTool,
    action: "knowledge:read",
    resourceType: "knowledge",
    resourceIdArg: "id",
  },
  {
    tool: readKnowledgeTool,
    action: "knowledge:read",
    resourceType: "knowledge",
    resourceIdArg: "knowledge_source_id",
  },
  { tool: listUsersTool, action: "identity:read", resourceType: "user" },
  { tool: getUserTool, action: "identity:read", resourceType: "user", resourceIdArg: "id" },
  { tool: listSystemAccountsTool, action: "identity:read", resourceType: "user" },
  { tool: listApiKeysTool, action: "api_key:read", resourceType: "api_key" },
  { tool: getApiKeyTool, action: "api_key:read", resourceType: "api_key", resourceIdArg: "id" },
  { tool: listPortalTokensTool, action: "portal_token:read", resourceType: "portal_token" },
  { tool: listCapabilityGapsTool, action: "discovery:read", resourceType: "capability_gap" },
  {
    tool: getExecutionTool,
    action: "execution:read",
    resourceType: "execution",
    resourceIdArg: "id",
  },
  { tool: listConnectorsTool, action: "connector:read", resourceType: "connector" },
  {
    tool: getConnectorTool,
    action: "connector:read",
    resourceType: "connector",
    resourceIdArg: "id",
  },
  {
    tool: findConnectorTool,
    action: "connector:read",
    resourceType: "connector",
    resourceIdArg: "id",
  },
  { tool: listSchedulesTool, action: "schedule:read", resourceType: "schedule" },
];

describe("read tools carry the LLM-path permission descriptor (checkToolPermission)", () => {
  for (const c of GATED) {
    it(`${c.tool.name} → ${c.action} / ${c.resourceType} / ${c.resourceIdArg ?? "*"}`, () => {
      expect(c.tool.permission).toEqual({
        action: c.action,
        resourceType: c.resourceType,
        ...(c.resourceIdArg ? { resourceIdArg: c.resourceIdArg } : {}),
      });
    });
  }
});

describe("deliberate read-tool carve-outs stay ungated on the LLM path", () => {
  it("whoami has no permission (self-introspection: returns the caller's own identity)", () => {
    expect(whoamiTool.permission).toBeUndefined();
  });
  it("get_engine_status has no permission (accessible low-sensitivity self-status)", () => {
    expect(getStatusSummaryTool.permission).toBeUndefined();
  });
});

describe("read tools carry a matching descriptor.rbac on the direct MCP path (RBAC_OVERRIDES)", () => {
  const byName = new Map<string, ToolDescriptor>(
    conversationToolProvider
      .list({ surface: "mcp", mcpMode: "admin" })
      .map((d) => [d.name, d] as const),
  );

  for (const c of GATED) {
    const d = byName.get(c.tool.name);
    if (!d) continue;
    it(`${c.tool.name} MCP descriptor.rbac.permission === ${c.action}`, () => {
      expect(d.rbac?.permission).toBe(c.action);
    });
  }

  it("whoami MCP descriptor carries no rbac (carve-out)", () => {
    const d = byName.get("whoami");
    if (d) expect(d.rbac).toBeUndefined();
  });
  it("get_engine_status MCP descriptor carries no rbac (carve-out)", () => {
    const d = byName.get("get_engine_status");
    if (d) expect(d.rbac).toBeUndefined();
  });
});

describe("gated read tools deny an unauthorized principal on MCP + write POLICY_DENIED", () => {
  const registry = buildRegistry([conversationToolProvider]);
  const DENY_CASES: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: "list_all_skills", args: {} },
    { name: "list_knowledge_sources", args: {} },
    { name: "list_users", args: {} },
    { name: "list_api_keys", args: {} },
    { name: "list_portal_tokens", args: {} },
    { name: "list_capability_gaps", args: {} },
    { name: "get_execution", args: { id: "00000000-0000-4000-8000-0000000000ff" } },
    {
      name: "read_knowledge",
      args: { knowledge_source_id: "00000000-0000-4000-8000-0000000000aa" },
    },
    { name: "list_connectors", args: {} },
    { name: "list_schedules", args: {} },
  ];

  for (const c of DENY_CASES) {
    test(`${c.name} → policy_denied + one POLICY_DENIED audit`, async () => {
      const { db, capture } = makeStubDb();
      const principal = makeTestPrincipal();
      const envelope = await dispatchTool(
        { registry, db, principal },
        { surface: "mcp", name: c.name, args: c.args },
      );
      expect(envelope.status).toBe("error");
      if (envelope.status === "error") expect(envelope.error_code).toBe("policy_denied");
      const denied = capture.inserts.filter((r) => r.action === AuditAction.POLICY_DENIED);
      expect(denied.length).toBe(1);
    });
  }
});

describe("carve-out read tools are not RBAC-denied on MCP", () => {
  const registry = buildRegistry([conversationToolProvider]);
  for (const name of ["whoami", "get_engine_status"]) {
    test(`${name} → no POLICY_DENIED audit`, async () => {
      const { db, capture } = makeStubDb();
      const principal = makeTestPrincipal();
      await dispatchTool({ registry, db, principal }, { surface: "mcp", name, args: {} });
      const denied = capture.inserts.filter((r) => r.action === AuditAction.POLICY_DENIED);
      expect(denied.length).toBe(0);
    });
  }
});
