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
import { prepareGate } from "../../sdk-wrap/gate-subjects.ts";
import { listSkillCandidatesTool } from "../skill-candidates.ts";
import { approveSkillCandidateTool, rejectSkillCandidateTool } from "./candidates.ts";

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
    const [row] = await testDb.db
      .insert(skillCandidates)
      .values({
        tenant_id: tenantId,
        scope: "global",
        pattern_kind: "success_pattern",
        title,
        body: `Body of ${title}`,
        examples: { examples: [], best_practices: [], pitfalls: [], doc_refs: [] },
        evidence: [],
        confidence: "high",
        fingerprint: `detected:${title}`,
      })
      .returning({ id: skillCandidates.id });
    if (!row) throw new Error("seed candidate failed");
    return row.id;
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
    test("rejects a batch and audits each candidate", async () => {
      const a = await propose("Reject Alpha");
      const b = await propose("Reject Beta");
      const result = await rejectSkillCandidateTool.execute(makeCtx(), {
        candidate_ids: [a, b, a],
        reason: "duplicate",
      });

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ rejected: 2, not_found: 0, already_decided: 0 });
      const data = result.data as { results: Array<{ candidate_id: string; outcome: string }> };
      expect(data.results).toEqual([
        { candidate_id: a, outcome: "rejected" },
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
        [`${a}:success`, `${b}:success`].sort(),
      );
    });

    test("after confirmation each id reports its own outcome and the rest are still rejected", async () => {
      const open = await propose("Reject Race Open");
      const raced = await propose("Reject Race Decided");
      const precheck = rejectSkillCandidateTool.precheck;
      if (!precheck) throw new Error("reject_skill_candidate declares no precheck");
      expect(await precheck(makeCtx(), { candidate_ids: [open, raced] })).toEqual({ ok: true });

      await rejectSkillCandidateTool.execute(makeCtx(), { candidate_ids: [raced] });
      const result = await rejectSkillCandidateTool.execute(makeCtx(), {
        candidate_ids: [open, raced, MISSING_UUID],
      });

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ rejected: 1, not_found: 1, already_decided: 1 });
      expect((result.data as { results: unknown }).results).toEqual([
        { candidate_id: open, outcome: "rejected" },
        { candidate_id: raced, outcome: "already_decided" },
        { candidate_id: MISSING_UUID, outcome: "not_found" },
      ]);
      expect(JSON.stringify(result)).not.toContain("nobody was asked");
      expect(await statusOf(open)).toBe("rejected");
    });

    test("the precheck refuses unknown and decided ids before anyone is asked", async () => {
      const open = await propose("Reject Precheck Open");
      const decided = await propose("Reject Precheck Decided");
      await rejectSkillCandidateTool.execute(makeCtx(), { candidate_ids: [decided] });
      const precheck = rejectSkillCandidateTool.precheck;
      if (!precheck) throw new Error("reject_skill_candidate declares no precheck");

      expect(await precheck(makeCtx(), { candidate_ids: [open] })).toEqual({ ok: true });
      const mixed = await precheck(makeCtx(), { candidate_ids: [open, decided] });
      expect(mixed.ok).toBe(false);
      if (mixed.ok) throw new Error("unreachable");
      expect(mixed.result).toMatchObject({
        ok: false,
        error_code: "already_decided",
        data: { not_found: [], already_decided: [decided] },
      });
      const fabricated = await precheck(makeCtx(), {
        candidate_ids: [MISSING_UUID, "not-a-uuid", decided],
      });
      if (fabricated.ok) throw new Error("fabricated ids passed the precheck");
      expect(fabricated.result).toMatchObject({
        error_code: "not_found",
        data: { not_found: [MISSING_UUID, "not-a-uuid"], already_decided: [decided] },
      });
      expect(await statusOf(open)).toBe("proposed");
    });

    test("an already decided candidate reports already_decided and rejects nothing", async () => {
      const id = await propose("Reject Gamma");
      await rejectSkillCandidateTool.execute(makeCtx(), { candidate_ids: [id] });
      const again = await rejectSkillCandidateTool.execute(makeCtx(), { candidate_ids: [id] });
      expect(again).toMatchObject({ ok: false, error_code: "already_decided" });
      expect(again.data).toMatchObject({
        rejected: 0,
        already_decided: 1,
        not_found: 0,
        results: [{ candidate_id: id, outcome: "already_decided" }],
      });
      expect(again.ok ? "" : (again.message ?? "")).toContain("Nothing was rejected");
      expect(again.ok ? "" : (again.message ?? "")).not.toContain("nobody was asked");
    });

    test("the input accepts 1 to 100 ids and no titles", () => {
      const schema = rejectSkillCandidateTool.inputSchema;
      expect(schema.safeParse({ candidate_ids: [] }).success).toBe(false);
      expect(
        schema.safeParse({ candidate_ids: Array.from({ length: 101 }, () => MISSING_UUID) })
          .success,
      ).toBe(false);
      expect(schema.safeParse({ candidate_ids: ["not-a-uuid"] }).success).toBe(false);
      expect(schema.safeParse({ candidate_ids: [MISSING_UUID] }).success).toBe(true);
      expect(
        Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape).sort(),
      ).toEqual(["candidate_ids", "reason"]);
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
      });
      expect(decision).toMatchObject({ allow: false, permission: "skill:write" });
      const denied = await rejectSkillCandidateTool.execute(ctx, {
        candidate_ids: [id],
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
      expect(await checkToolPermission(writerCtx, permission, { candidate_ids: [id] })).toEqual({
        allow: true,
      });
    });

    test("waits for human confirmation and never shows model supplied titles", () => {
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
        reason: "dup",
      });
    });
  });

  describe("approve_skill_candidate", () => {
    test("the confirmation shows the stored title, the target and an excerpt, and binds the digest", async () => {
      const id = await propose("Approve Card");
      const prepared = await prepareGate(
        "approve_skill_candidate",
        { candidate_id: id, title: "Model title" },
        tenantId,
        testDb.db,
      );
      expect(prepared.pending_output).toEqual({
        candidate_id: id,
        subjects: [{ id, title: "Approve Card", status: "proposed" }],
        target: { kind: "skill_draft" },
        body_excerpt: "Body of Approve Card",
      });
      expect(prepared.args.expected_review_digest).toMatch(/^[a-f0-9]{64}$/);
    });

    test("a collected learning left as a proposed candidate is never approved or rejected here", async () => {
      const [learning] = await testDb.db
        .insert(skillCandidates)
        .values({
          tenant_id: tenantId,
          scope: "global",
          pattern_kind: "knowledge_learning",
          title: "Rota",
          body: "Page by phone.",
          tags: ["domain:ops"],
          evidence: [],
          confidence: "medium",
          fingerprint: "approve-card-fact",
        })
        .returning();
      if (!learning) throw new Error("seed learning failed");
      const gate = await prepareGate(
        "approve_skill_candidate",
        { candidate_id: learning.id },
        tenantId,
        testDb.db,
      );
      expect(gate.pending_output).toEqual({
        candidate_id: learning.id,
        subjects: [{ id: learning.id, title: null, status: "not_found" }],
      });
      const approvePrecheck = await approveSkillCandidateTool.precheck?.(makeCtx(), {
        candidate_id: learning.id,
      });
      expect(approvePrecheck).toMatchObject({ ok: false, result: { error_code: "not_found" } });
      expect(
        await approveSkillCandidateTool.execute(makeCtx(), { candidate_id: learning.id }),
      ).toMatchObject({ ok: false, error_code: "not_found" });
      const rejectPrecheck = await rejectSkillCandidateTool.precheck?.(makeCtx(), {
        candidate_ids: [learning.id],
      });
      expect(rejectPrecheck).toMatchObject({ ok: false, result: { error_code: "not_found" } });
      expect(await statusOf(learning.id)).toBe("proposed");
    });

    test("a draft skill result says it needs activation", async () => {
      const id = await propose("Approve Draft");
      const result = await approveSkillCandidateTool.execute(makeCtx(), { candidate_id: id });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({
        skill_status: "draft",
        activation_required: true,
        message: expect.stringContaining("draft"),
      });
      expect(await statusOf(id)).toBe("approved");
    });

    test("a candidate changed after the confirmation was shown fails with changed_since_review", async () => {
      const id = await propose("Approve Changed");
      const prepared = await prepareGate(
        "approve_skill_candidate",
        { candidate_id: id },
        tenantId,
        testDb.db,
      );
      await testDb.db
        .update(skillCandidates)
        .set({ body: "Edited after review" })
        .where(and(eq(skillCandidates.tenant_id, tenantId), eq(skillCandidates.id, id)));
      const result = await approveSkillCandidateTool.execute(makeCtx(), prepared.args);
      expect(result).toMatchObject({ ok: false, error_code: "changed_since_review" });
      expect(await statusOf(id)).toBe("proposed");
    });

    test("unknown and decided candidates are refused before the gate and at execution", async () => {
      const precheck = approveSkillCandidateTool.precheck;
      if (!precheck) throw new Error("approve_skill_candidate declares no precheck");
      const missing = await precheck(makeCtx(), { candidate_id: MISSING_UUID });
      if (missing.ok) throw new Error("unknown id passed the precheck");
      expect(missing.result).toMatchObject({ error_code: "not_found" });
      expect(
        await approveSkillCandidateTool.execute(makeCtx(), { candidate_id: MISSING_UUID }),
      ).toMatchObject({ ok: false, error_code: "not_found" });

      const id = await propose("Approve Decided");
      await rejectSkillCandidateTool.execute(makeCtx(), { candidate_ids: [id] });
      const decided = await precheck(makeCtx(), { candidate_id: id });
      if (decided.ok) throw new Error("decided id passed the precheck");
      expect(decided.result).toMatchObject({ error_code: "already_decided" });
      const late = await approveSkillCandidateTool.execute(makeCtx(), { candidate_id: id });
      expect(late).toMatchObject({ ok: false, error_code: "already_decided" });
      expect(late.ok ? "" : (late.message ?? "")).not.toContain("nobody was asked");
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
