import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../../audit/types.ts";
import { auditLog, skillCandidates, tenants, users } from "../../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../../db/tests/setup.ts";
import { EngineClient } from "../../../../engine-client/index.ts";
import { createRole, grantPermissionToRole } from "../../../../rbac/roles.ts";
import { isDangerousTool } from "../../../dangerous-tools.ts";
import { TOOL_POLICIES } from "../../../tool-policies.ts";
import type { ToolContext } from "../../index.ts";
import { checkToolPermission } from "../../permission-gate.ts";
import { listSkillCandidatesTool } from "../skill-candidates.ts";
import { rejectSkillCandidateTool } from "./candidates.ts";
import { createSkillTool } from "./create-skill.ts";

const MISSING_UUID = "00000000-0000-4000-8000-000000009999";

describe("skill candidate chat tools", () => {
  let testDb: TestDb;
  let tenantId = "";

  function makeCtx(actorId: string | null = null): ToolContext {
    return {
      db: testDb.db,
      tenant_id: tenantId,
      conversation_id: "00000000-0000-4000-8000-000000000098",
      actor_id: actorId,
      connector_id: null,
      workflow_id: null,
      engineClient: new EngineClient({ tenant_id: tenantId, actor_id: actorId, db: testDb.db }),
    } as unknown as ToolContext;
  }

  async function propose(title: string): Promise<string> {
    const result = await createSkillTool.execute(makeCtx(), {
      scope: "global",
      title,
      body: `Body of ${title}`,
    });
    return (result.data as { candidate_id: string }).candidate_id;
  }

  async function statusOf(id: string): Promise<string | undefined> {
    const rows = await testDb.db
      .select({ status: skillCandidates.status })
      .from(skillCandidates)
      .where(and(eq(skillCandidates.tenant_id, tenantId), eq(skillCandidates.id, id)));
    return rows[0]?.status;
  }

  beforeAll(async () => {
    testDb = await createTestDb("candidate-chat-tools");
    const [row] = await testDb.db
      .insert(tenants)
      .values({ slug: "cct-tenant", display_name: "CCT Tenant" })
      .returning();
    if (!row) throw new Error("tenant seed failed");
    tenantId = row.id;
  });

  afterAll(async () => {
    await testDb?.cleanup();
  });

  describe("reject_skill_candidate", () => {
    test("rejects a batch, reports the non-actionable id and audits each candidate", async () => {
      const a = await propose("Reject Alpha");
      const b = await propose("Reject Beta");
      const result = await rejectSkillCandidateTool.execute(makeCtx(), {
        candidate_ids: [a, MISSING_UUID, b, a],
        titles: ["Alpha", "Missing", "Beta", "Alpha"],
        reason: "duplicate",
      });

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ rejected: 2, not_actionable: 1 });
      const data = result.data as { results: Array<{ candidate_id: string; outcome: string }> };
      expect(data.results).toEqual([
        { candidate_id: a, outcome: "rejected" },
        { candidate_id: MISSING_UUID, outcome: "not_actionable" },
        { candidate_id: b, outcome: "rejected" },
      ]);
      expect(await statusOf(a)).toBe("rejected");
      expect(await statusOf(b)).toBe("rejected");

      const domainAudit = await testDb.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenantId),
            eq(auditLog.action, AuditAction.SKILL_CANDIDATE_REJECTED),
          ),
        );
      expect(domainAudit.length).toBeGreaterThanOrEqual(2);
      const chatAudit = await testDb.db
        .select({ resource_id: auditLog.resource_id, result: auditLog.result })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenantId),
            eq(auditLog.action, "conversation.reject_skill_candidate"),
          ),
        );
      expect(chatAudit.map((r) => `${r.resource_id}:${r.result}`).sort()).toEqual(
        [`${a}:success`, `${b}:success`, `${MISSING_UUID}:error`].sort(),
      );
    });

    test("an already decided candidate is not actionable and the call reports failure", async () => {
      const id = await propose("Reject Gamma");
      await rejectSkillCandidateTool.execute(makeCtx(), { candidate_ids: [id], titles: ["t"] });
      const again = await rejectSkillCandidateTool.execute(makeCtx(), {
        candidate_ids: [id],
        titles: ["t"],
      });
      expect(again.ok).toBe(false);
      expect(again.data).toMatchObject({
        error: "skill_candidate_not_actionable",
        rejected: 0,
        not_actionable: 1,
      });
    });

    test("the input accepts 1 to 100 ids only", () => {
      const schema = rejectSkillCandidateTool.inputSchema;
      expect(schema.safeParse({ candidate_ids: [], titles: [] }).success).toBe(false);
      expect(
        schema.safeParse({
          candidate_ids: Array.from({ length: 101 }, () => MISSING_UUID),
          titles: Array.from({ length: 101 }, () => "t"),
        }).success,
      ).toBe(false);
      expect(schema.safeParse({ candidate_ids: ["not-a-uuid"], titles: ["t"] }).success).toBe(
        false,
      );
      expect(schema.safeParse({ candidate_ids: [MISSING_UUID], titles: ["t"] }).success).toBe(true);
      expect(schema.safeParse({ candidate_ids: [MISSING_UUID] }).success).toBe(false);
      expect(schema.safeParse({ candidate_ids: [MISSING_UUID], titles: ["a", "b"] }).success).toBe(
        false,
      );
    });

    test("is denied for a role without skill:write and leaves the candidate proposed", async () => {
      const id = await propose("Reject Delta");
      const readOnly = await createRole(testDb.db, tenantId, "skill-reader");
      await grantPermissionToRole(testDb.db, tenantId, readOnly.id, "skill:read");
      const [reader] = await testDb.db
        .insert(users)
        .values({ tenant_id: tenantId, email: "reader@test.local", role_id: readOnly.id })
        .returning();
      if (!reader) throw new Error("seed user failed");
      const ctx = {
        ...makeCtx(reader.id),
        principal: {
          provider: "api_key",
          kind: "user",
          id: reader.id,
          tenant_id: tenantId,
          roles: [],
        },
      } as unknown as ToolContext;

      const permission = rejectSkillCandidateTool.permission;
      if (!permission) throw new Error("reject_skill_candidate declares no permission");
      const decision = await checkToolPermission(ctx, permission, {
        candidate_ids: [id],
        titles: ["t"],
      });
      expect(decision).toMatchObject({ allow: false, permission: "skill:write" });
      const denied = await rejectSkillCandidateTool.execute(ctx, {
        candidate_ids: [id],
        titles: ["t"],
      });
      expect(denied.ok).toBe(false);
      expect(denied.data).toMatchObject({ error: "permission_denied", permission: "skill:write" });
      expect(await statusOf(id)).toBe("proposed");

      const writer = await createRole(testDb.db, tenantId, "skill-writer");
      await grantPermissionToRole(testDb.db, tenantId, writer.id, "skill:write");
      const [editor] = await testDb.db
        .insert(users)
        .values({ tenant_id: tenantId, email: "writer@test.local", role_id: writer.id })
        .returning();
      if (!editor) throw new Error("seed user failed");
      const writerCtx = {
        ...makeCtx(editor.id),
        principal: {
          provider: "api_key",
          kind: "user",
          id: editor.id,
          tenant_id: tenantId,
          roles: [],
        },
      } as unknown as ToolContext;
      expect(
        await checkToolPermission(writerCtx, permission, { candidate_ids: [id], titles: ["t"] }),
      ).toEqual({
        allow: true,
      });
    });

    test("waits for human confirmation and shows what will be rejected", () => {
      expect(isDangerousTool("reject_skill_candidate")).toBe(true);
      const policy = TOOL_POLICIES.reject_skill_candidate;
      expect(policy?.defaultMode).toBe("confirm_before_execution");
      expect(policy?.neverGate).not.toBe(true);
      expect(
        policy?.buildPendingOutput?.({
          candidate_ids: [MISSING_UUID, MISSING_UUID],
          titles: ["First", "Second"],
          reason: "dup",
        }),
      ).toEqual({
        candidate_count: 2,
        candidate_ids: [MISSING_UUID, MISSING_UUID],
        titles: ["First", "Second"],
        reason: "dup",
      });
    });
  });

  describe("list_skill_candidates", () => {
    test("pages through every candidate and reports the total", async () => {
      const baseline = (await listSkillCandidatesTool.execute(makeCtx(), {})).data as {
        total: number;
      };
      for (let i = 0; i < 5; i++) await propose(`Page Candidate ${i}`);

      const first = (await listSkillCandidatesTool.execute(makeCtx(), { limit: 2 })).data as {
        total: number;
        limit: number;
        offset: number;
        has_more: boolean;
        next_offset?: number;
        candidates: Array<Record<string, unknown>>;
      };
      expect(first.total).toBe(baseline.total + 5);
      expect(first.candidates).toHaveLength(2);
      expect(first.has_more).toBe(true);
      expect(first.next_offset).toBe(2);
      expect(first.candidates[0]).toMatchObject({
        status: expect.any(String),
        pattern_kind: expect.any(String),
        confidence: expect.any(String),
        evidence_count: expect.any(Number),
      });

      const seen = new Set<string>();
      let offset = 0;
      for (;;) {
        const page = (await listSkillCandidatesTool.execute(makeCtx(), { limit: 2, offset }))
          .data as {
          has_more: boolean;
          next_offset?: number;
          candidates: Array<{ id: string }>;
        };
        for (const c of page.candidates) seen.add(c.id);
        if (!page.has_more) break;
        offset = page.next_offset ?? 0;
      }
      expect(seen.size).toBe(first.total);
    });

    test("filters by status and counts that status only", async () => {
      const proposed = (
        await listSkillCandidatesTool.execute(makeCtx(), { status: "proposed", limit: 200 })
      ).data as { total: number; candidates: Array<{ status: string }> };
      expect(proposed.candidates.every((c) => c.status === "proposed")).toBe(true);
      expect(proposed.total).toBe(proposed.candidates.length);
    });

    test("rejects a limit above the maximum", () => {
      expect(listSkillCandidatesTool.inputSchema.safeParse({ limit: 201 }).success).toBe(false);
      expect(listSkillCandidatesTool.inputSchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(listSkillCandidatesTool.inputSchema.safeParse({}).success).toBe(true);
    });
  });
});
