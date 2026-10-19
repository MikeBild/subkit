import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditAction } from "../../../../audit/types.ts";
import { tenants } from "../../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../../db/tests/setup.ts";
import { EngineClient } from "../../../../engine-client/index.ts";
import { createSkill } from "../../../../skills/service.ts";
import { dispatchTool } from "../../../../tools/dispatcher.ts";
import { conversationToolProvider } from "../../../../tools/providers/conversation.ts";
import { buildRegistry } from "../../../../tools/registry.ts";
import {
  makeStubDb,
  makeTestPrincipal,
  usePolicyFixture,
} from "../../../../tools/tests/_helpers.ts";
import type { ToolContext } from "../../index.ts";
import { deleteSkillTool } from "./delete-skill.ts";
import { updateSkillTool } from "./update-skill.ts";

usePolicyFixture();

const CONVO_ID = "00000000-0000-4000-8000-000000000099";
const MISSING_UUID = "00000000-0000-4000-8000-000000009999";

describe("skill write tools — integration (b–d)", () => {
  let testDb: TestDb;
  let tenantAId = "";
  let tenantBId = "";

  function makeCtx(tenantId: string): ToolContext {
    const engineClient = new EngineClient({
      tenant_id: tenantId,
      actor_id: null,
      db: testDb.db,
    });
    return {
      db: testDb.db,
      tenant_id: tenantId,
      conversation_id: CONVO_ID,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient,
      getDraft: () => ({ workflow: { name: "", steps: [] } }) as never,
      setDraft: async () => {},
    } as unknown as ToolContext;
  }

  beforeAll(async () => {
    testDb = await createTestDb("skill-write-tools");
    const [rowA] = await testDb.db
      .insert(tenants)
      .values({ slug: "swt-tenant-a", display_name: "SWT Tenant A" })
      .returning();
    const [rowB] = await testDb.db
      .insert(tenants)
      .values({ slug: "swt-tenant-b", display_name: "SWT Tenant B" })
      .returning();
    if (!rowA || !rowB) throw new Error("tenant seed failed");
    tenantAId = rowA.id;
    tenantBId = rowB.id;
  });

  afterAll(async () => {
    await testDb?.cleanup();
  });

  describe("(b) update_skill", () => {
    test("happy path: title patch applied, audit_log_id returned", async () => {
      const ctx = makeCtx(tenantAId);

      const seedSkill = await createSkill(
        {
          tenant_id: tenantAId,
          input: { scope: "global", title: "Before Update", body: "Original body content" },
        },
        testDb.db,
      );

      const result = await updateSkillTool.execute(ctx, {
        id: seedSkill.id,
        title: "After Update",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const data = result.data as {
        updated: boolean;
        skill: { id: string; title: string };
        audit_log_id: string;
      };
      expect(data.updated).toBe(true);
      expect(data.skill.title).toBe("After Update");
      expect(data.skill.id).toBe(seedSkill.id);
      expect(typeof data.audit_log_id).toBe("string");
    });

    test("missing id → not_found", async () => {
      const ctx = makeCtx(tenantAId);
      const result = await updateSkillTool.execute(ctx, {
        id: MISSING_UUID,
        title: "Should not apply",
      });
      expect(result.ok).toBe(false);
      const data = result.data as { error: string };
      expect(data.error).toBe("not_found");
    });
  });

  describe("(c) delete_skill", () => {
    test("happy path: skill deleted, id + audit_log_id returned", async () => {
      const ctx = makeCtx(tenantAId);

      const toDelete = await createSkill(
        {
          tenant_id: tenantAId,
          input: { scope: "global", title: "To Be Deleted", body: "Ephemeral" },
        },
        testDb.db,
      );

      const result = await deleteSkillTool.execute(ctx, { id: toDelete.id });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const data = result.data as { deleted: boolean; id: string; audit_log_id: string };
      expect(data.deleted).toBe(true);
      expect(data.id).toBe(toDelete.id);
      expect(typeof data.audit_log_id).toBe("string");
    });

    test("missing id → not_found", async () => {
      const ctx = makeCtx(tenantAId);
      const result = await deleteSkillTool.execute(ctx, { id: MISSING_UUID });
      expect(result.ok).toBe(false);
      const data = result.data as { error: string };
      expect(data.error).toBe("not_found");
    });
  });

  describe("(d) tenant isolation", () => {
    test("update_skill using another tenant's skill id → not_found (no cross-tenant update)", async () => {
      const bSkill = await createSkill(
        {
          tenant_id: tenantBId,
          input: { scope: "global", title: "Tenant B Only Skill", body: "Belongs to tenant B" },
        },
        testDb.db,
      );

      const ctxA = makeCtx(tenantAId);
      const result = await updateSkillTool.execute(ctxA, {
        id: bSkill.id,
        title: "Stolen update",
      });
      expect(result.ok).toBe(false);
      const data = result.data as { error: string };
      expect(data.error).toBe("not_found");
    });

    test("delete_skill using another tenant's skill id → not_found (no cross-tenant deletion)", async () => {
      const bSkill = await createSkill(
        {
          tenant_id: tenantBId,
          input: {
            scope: "global",
            title: "Tenant B Skill for Delete Guard",
            body: "Belongs to tenant B",
          },
        },
        testDb.db,
      );

      const ctxA = makeCtx(tenantAId);
      const result = await deleteSkillTool.execute(ctxA, { id: bSkill.id });
      expect(result.ok).toBe(false);
      const data = result.data as { error: string };
      expect(data.error).toBe("not_found");
    });
  });
});

describe("(e) RBAC credential ceiling — skill / knowledge tools", () => {
  const registry = buildRegistry([conversationToolProvider]);

  test("[workflow:read] scoped principal is denied save_learning via credential ceiling", async () => {
    const { db, capture } = makeStubDb();
    const principal = makeTestPrincipal({ scopes: ["workflow:read"], roles: [] });

    const envelope = await dispatchTool(
      { registry, db, principal },
      { surface: "mcp", name: "save_learning", args: {} },
    );

    expect(envelope.status).toBe("error");
    if (envelope.status === "error") {
      expect(envelope.error_code).toBe("policy_denied");
    }
    const denied = capture.inserts.filter((r) => r.action === AuditAction.POLICY_DENIED);
    expect(denied.length).toBe(1);
    const requested = capture.inserts.filter((r) => r.action === AuditAction.APPROVAL_REQUESTED);
    expect(requested.length).toBe(0);
  });

  test("[workflow:read] scoped principal is denied create_knowledge_source via credential ceiling", async () => {
    const { db, capture } = makeStubDb();
    const principal = makeTestPrincipal({ scopes: ["workflow:read"], roles: [] });

    const envelope = await dispatchTool(
      { registry, db, principal },
      { surface: "mcp", name: "create_knowledge_source", args: {} },
    );

    expect(envelope.status).toBe("error");
    if (envelope.status === "error") {
      expect(envelope.error_code).toBe("policy_denied");
    }
    const denied = capture.inserts.filter((r) => r.action === AuditAction.POLICY_DENIED);
    expect(denied.length).toBe(1);
  });

  test("[skill:propose] scoped admin key passes the ceiling and reaches intake collection", async () => {
    const { db, capture } = makeStubDb();
    const principal = makeTestPrincipal({ scopes: ["skill:propose"], roles: ["admin"] });

    const envelope = await dispatchTool(
      { registry, db, principal },
      {
        surface: "mcp",
        name: "save_learning",
        args: { title: "Ceiling Probe", body: "probe body" },
      },
    );

    expect(envelope.status).toBe("error");
    if (envelope.status === "error") expect(envelope.error_code).toBe("tool_execute_failed");
    const denied = capture.inserts.filter((r) => r.action === AuditAction.POLICY_DENIED);
    expect(denied.length).toBe(0);
  });

  test("[knowledge:write] scoped admin key is NOT ceiling-denied for create_knowledge_source", async () => {
    const { db, capture } = makeStubDb();
    const principal = makeTestPrincipal({ scopes: ["knowledge:write"], roles: ["admin"] });

    const envelope = await dispatchTool(
      { registry, db, principal },
      {
        surface: "mcp",
        name: "create_knowledge_source",
        args: { mode: "inline", name: "Ceiling Probe KS", content: "probe content" },
      },
    );

    expect(envelope.status).toBe("needs_confirm");
    const denied = capture.inserts.filter((r) => r.action === AuditAction.POLICY_DENIED);
    expect(denied.length).toBe(0);
  });
});

describe("(f) confirm-gate on MCP surface", () => {
  const registry = buildRegistry([conversationToolProvider]);
  const adminPrincipal = makeTestPrincipal({ scopes: ["*"], roles: ["admin"] });

  test("save_learning collection does not mint an approval", async () => {
    const { db, capture } = makeStubDb();

    const envelope = await dispatchTool(
      { registry, db, principal: adminPrincipal },
      {
        surface: "mcp",
        name: "save_learning",
        args: { title: "Confirm Gate Probe", body: "probe body" },
      },
    );

    expect(envelope.status).toBe("error");
    if (envelope.status === "error") expect(envelope.error_code).toBe("tool_execute_failed");
    const approvalRows = capture.inserts.filter((r) => r.action === AuditAction.APPROVAL_REQUESTED);
    expect(approvalRows.length).toBe(0);
  });

  test("delete_skill dispatched on MCP pauses with one local approval", async () => {
    const { db, capture } = makeStubDb();

    const envelope = await dispatchTool(
      { registry, db, principal: adminPrincipal },
      {
        surface: "mcp",
        name: "delete_skill",
        args: { id: MISSING_UUID },
      },
    );

    expect(envelope.status).toBe("needs_confirm");
    const approvalRows = capture.inserts.filter((r) => r.action === AuditAction.APPROVAL_REQUESTED);
    expect(approvalRows.length).toBe(1);
  });
});
