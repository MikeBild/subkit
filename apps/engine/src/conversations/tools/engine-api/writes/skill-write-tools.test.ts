import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { proposeLearning } from "../../../../agent/sessions.ts";
import { AuditAction } from "../../../../audit/types.ts";
import { auditLog, skillCandidates, skills, tenants } from "../../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../../db/tests/setup.ts";
import { EngineClient } from "../../../../engine-client/index.ts";
import { createSkill } from "../../../../skills/service.ts";
import { dispatchTool } from "../../../../tools/dispatcher.ts";
import { conversationToolProvider } from "../../../../tools/providers/conversation.ts";
import { buildRegistry } from "../../../../tools/registry.ts";
import { makeStubDb, makeTestPrincipal } from "../../../../tools/tests/_helpers.ts";
import type { ToolContext } from "../../index.ts";
import { createSkillTool } from "./create-skill.ts";
import { deleteSkillTool } from "./delete-skill.ts";
import { updateSkillTool } from "./update-skill.ts";

const CONVO_ID = "00000000-0000-4000-8000-000000000099";
const MISSING_UUID = "00000000-0000-4000-8000-000000009999";

describe("skill write tools — integration (a–d)", () => {
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

  describe("(a) create_skill — proposes a candidate, never an active skill", () => {
    test("files a proposed session_learning candidate + skill_candidate.proposed audit; NO skill row", async () => {
      const ctx = makeCtx(tenantAId);
      const result = await createSkillTool.execute(ctx, {
        scope: "global",
        title: "Test Skill Alpha",
        body: "Guide body for testing create_skill",
        tags: ["domain:testing"],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const data = result.data as {
        created: boolean;
        action: string;
        candidate_id: string;
        next_best_actions: string[];
      };
      expect(data.created).toBe(false);
      expect(data.action).toBe("proposed");
      expect(typeof data.candidate_id).toBe("string");
      expect(data.next_best_actions).toContain("approve_skill_candidate");

      const candidateRows = await testDb.db
        .select({
          status: skillCandidates.status,
          pattern_kind: skillCandidates.pattern_kind,
          title: skillCandidates.title,
        })
        .from(skillCandidates)
        .where(
          and(eq(skillCandidates.tenant_id, tenantAId), eq(skillCandidates.id, data.candidate_id)),
        );
      expect(candidateRows.length).toBe(1);
      expect(candidateRows[0]?.status).toBe("proposed");
      expect(candidateRows[0]?.pattern_kind).toBe("session_learning");
      expect(candidateRows[0]?.title).toBe("Test Skill Alpha");

      const candidateAudit = await testDb.db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenantAId),
            eq(auditLog.action, AuditAction.SKILL_CANDIDATE_PROPOSED),
            eq(auditLog.resource_id, data.candidate_id),
          ),
        );
      expect(candidateAudit.length).toBe(1);

      const skillRows = await testDb.db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, tenantAId), eq(skills.title, "Test Skill Alpha")));
      expect(skillRows.length).toBe(0);
      const skillCreatedAudit = await testDb.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(eq(auditLog.tenant_id, tenantAId), eq(auditLog.action, AuditAction.SKILL_CREATED)),
        );
      expect(skillCreatedAudit.length).toBe(0);
    });

    test("identical re-proposal dedups; a REVISED body files a fresh candidate", async () => {
      const ctx = makeCtx(tenantAId);
      const first = await createSkillTool.execute(ctx, {
        scope: "global",
        title: "Dedup Skill",
        body: "v1",
      });
      expect(first.ok).toBe(true);
      const firstData = first.data as { candidate_id: string };

      const identical = await createSkillTool.execute(ctx, {
        scope: "global",
        title: "Dedup Skill",
        body: "v1",
      });
      expect(identical.ok).toBe(true);
      const identicalData = identical.data as { candidate_id: string; action: string };
      expect(identicalData.action).toBe("updated");
      expect(identicalData.candidate_id).toBe(firstData.candidate_id);

      const revised = await createSkillTool.execute(ctx, {
        scope: "global",
        title: "Dedup Skill",
        body: "v2",
      });
      expect(revised.ok).toBe(true);
      const revisedData = revised.data as { candidate_id: string; action: string };
      expect(revisedData.action).toBe("proposed");
      expect(revisedData.candidate_id).not.toBe(firstData.candidate_id);
      const rows = await testDb.db
        .select({ body: skillCandidates.body })
        .from(skillCandidates)
        .where(
          and(
            eq(skillCandidates.tenant_id, tenantAId),
            eq(skillCandidates.id, revisedData.candidate_id),
          ),
        );
      expect(rows[0]?.body).toBe("v2");
      const staleRows = await testDb.db
        .select({ status: skillCandidates.status })
        .from(skillCandidates)
        .where(
          and(
            eq(skillCandidates.tenant_id, tenantAId),
            eq(skillCandidates.id, firstData.candidate_id),
          ),
        );
      expect(staleRows[0]?.status).toBe("superseded");

      const reverted = await createSkillTool.execute(ctx, {
        scope: "global",
        title: "Dedup Skill",
        body: "v1",
      });
      expect(reverted.ok).toBe(true);
      const revertedData = reverted.data as { candidate_id: string; action: string };
      expect(revertedData.action).toBe("updated");
      expect(revertedData.candidate_id).toBe(firstData.candidate_id);
      const afterRevert = await testDb.db
        .select({ id: skillCandidates.id, status: skillCandidates.status })
        .from(skillCandidates)
        .where(
          and(eq(skillCandidates.tenant_id, tenantAId), eq(skillCandidates.title, "Dedup Skill")),
        );
      const byId = new Map(afterRevert.map((r) => [r.id, r.status]));
      expect(byId.get(firstData.candidate_id)).toBe("proposed");
      expect(byId.get(revisedData.candidate_id)).toBe("superseded");
    });

    test("a re-taught learning revives with the NEW body after a cross-title supersede", async () => {
      const learned = await proposeLearning({
        tenant_id: tenantAId,
        title: "Retry With Backoff",
        body: "body A",
        domains: [],
        kind: "practice",
        actor: null,
        confidence: "high",
        evidence_summary: "test",
        db: testDb.db,
      });
      expect(learned.action).toBe("proposed");

      const ctx = makeCtx(tenantAId);
      const authored = await createSkillTool.execute(ctx, {
        scope: "global",
        title: "Retry With Backoff",
        body: "body B",
      });
      expect(authored.ok).toBe(true);

      const retaught = await proposeLearning({
        tenant_id: tenantAId,
        title: "Retry With Backoff",
        body: "body C",
        domains: [],
        kind: "practice",
        actor: null,
        confidence: "high",
        evidence_summary: "test",
        db: testDb.db,
      });
      expect(retaught.action).toBe("updated");
      expect(retaught.candidate_id).toBe(learned.candidate_id);
      const rows = await testDb.db
        .select({ status: skillCandidates.status, body: skillCandidates.body })
        .from(skillCandidates)
        .where(
          and(
            eq(skillCandidates.tenant_id, tenantAId),
            eq(skillCandidates.id, String(learned.candidate_id)),
          ),
        );
      expect(rows[0]?.status).toBe("proposed");
      expect(rows[0]?.body).toBe("body C");
    });

    test("scope/entity mismatch fails at PROPOSAL time, not at the reviewer's approve step", async () => {
      const ctx = makeCtx(tenantAId);
      expect(
        createSkillTool.execute(ctx, {
          scope: "connector",
          title: "Unbound Connector Skill",
          body: "never approvable",
        }),
      ).rejects.toThrow();
    });
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

  test("[workflow:read] scoped principal is denied create_skill via credential ceiling", async () => {
    const { db, capture } = makeStubDb();
    const principal = makeTestPrincipal({ scopes: ["workflow:read"], roles: [] });

    const envelope = await dispatchTool(
      { registry, db, principal },
      { surface: "mcp", name: "create_skill", args: {} },
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

  test("[skill:write] scoped admin key passes the ceiling and reaches candidate preparation", async () => {
    const { db, capture } = makeStubDb();
    const principal = makeTestPrincipal({ scopes: ["skill:write"], roles: ["admin"] });

    const envelope = await dispatchTool(
      { registry, db, principal },
      {
        surface: "mcp",
        name: "create_skill",
        args: { scope: "global", title: "Ceiling Probe", body: "probe body" },
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

  test("create_skill candidate preparation does not mint an approval", async () => {
    const { db, capture } = makeStubDb();

    const envelope = await dispatchTool(
      { registry, db, principal: adminPrincipal },
      {
        surface: "mcp",
        name: "create_skill",
        args: { scope: "global", title: "Confirm Gate Probe", body: "probe body" },
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
