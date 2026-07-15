// Integration + unit tests for the skill MCP write tools.
//
// Coverage:
//  (a) create_skill  — files a PROPOSED session_learning candidate (review
//                      queue), skill_candidate.proposed audit, NO skill row,
//                      NO skill.created audit; identical re-proposal dedups.
//  (b) update_skill  — patch applied; missing id → not_found.
//  (c) delete_skill  — deleted; missing id → not_found.
//  (d) tenant isolation — a skill from another tenant is not updatable/deletable.
//  (e) RBAC credential ceiling — a principal scoped to ["workflow:read"] is denied
//                      create_skill AND create_knowledge_source via the dispatcher
//                      credential ceiling; a ["skill:write"] / ["knowledge:write"]
//                      principal is NOT denied by the ceiling (ceiling passes and the
//                      call reaches the executor — no policy_denial).
//  (f) confirm-gate  — on the MCP surface a tenant_write proceeds directly (the
//                      client's native destructiveHint dialog is the human gate):
//                      NO needs_confirm and NO minted approval. Chat still gates —
//                      see tools/tests/policy-decide.test.ts + dispatcher.test.ts.
//
// Architecture note:
//   Tests (a)–(d) live inside a single "integration" describe that owns
//   its own beforeAll/afterAll. A failing createTestDb (no Postgres, too
//   many connections) fails only that describe — the unit describes (e)–(f)
//   still run because they operate against a stub DB.
//
// Pool-isolation guarantee: the per-file createTestDb allocates an isolated
// database so parallel file runs never bleed state into each other and do not
// use the process-global pool that getDb() hands out.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
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

// Fixed deterministic UUIDs — avoids crypto.randomUUID() in test source
// which would trip the determinism gate.
const CONVO_ID = "00000000-0000-4000-8000-000000000099";
const MISSING_UUID = "00000000-0000-4000-8000-000000009999";

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests (a)–(d): real Postgres via createTestDb
// ─────────────────────────────────────────────────────────────────────────────

describe("skill write tools — integration (a–d)", () => {
  let testDb: TestDb;
  let tenantAId = "";
  let tenantBId = "";

  /** Build a ToolContext wired to the per-file isolated test database. */
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
      // Skill write tools never read/write the draft; stub keeps types happy.
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

  // ─── (a) create_skill ───────────────────────────────────────────────────────

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
      // Honest envelope: nothing tenant-visible was activated.
      expect(data.created).toBe(false);
      expect(data.action).toBe("proposed");
      expect(typeof data.candidate_id).toBe("string");
      expect(data.next_best_actions).toContain("approve_skill_candidate");

      // The candidate landed in the review queue (same kind the
      // `sk learnings review` queue and welcome-row count select on).
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

      // Candidate lifecycle audit exists …
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

      // … and NO active skill and NO skill.created audit were produced.
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
      // Content is part of the identity on purpose: upsertFromSignal's
      // update branch persists only confidence/version/evidence, so a
      // title-only identity would report "updated" while silently
      // keeping the OLD body — and a rejected title would block every
      // future revision.
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
      // The revision's own body is what the reviewer will approve.
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
      // …and the stale v1 candidate was superseded, not left cluttering
      // the review queue (revision retirement). Note: the title contains
      // BOTH a lowercase "s" run and normal spaces — regression cover for
      // the tagged-template \\s+ cooking bug (a single backslash made the
      // SQL replace the LETTER "s", silently no-oping retirement).
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

      // Revert: re-proposing v1 verbatim REVIVES the superseded candidate
      // (no human reviewed it — a "skipped: already reviewed" would lie)
      // and retires v2 in turn.
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

    test("scope/entity mismatch fails at PROPOSAL time, not at the reviewer's approve step", async () => {
      const ctx = makeCtx(tenantAId);
      // connector scope without connector_id — the schema mirror of
      // skills/service.ts validateScope rejects it before any row exists.
      expect(
        createSkillTool.execute(ctx, {
          scope: "connector",
          title: "Unbound Connector Skill",
          body: "never approvable",
        }),
      ).rejects.toThrow();
    });
  });

  // ─── (b) update_skill ───────────────────────────────────────────────────────

  describe("(b) update_skill", () => {
    test("happy path: title patch applied, audit_log_id returned", async () => {
      const ctx = makeCtx(tenantAId);

      // Seed via the admin/REST service — the conversational tool only
      // proposes candidates now.
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

  // ─── (c) delete_skill ───────────────────────────────────────────────────────

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

  // ─── (d) tenant isolation ───────────────────────────────────────────────────

  describe("(d) tenant isolation", () => {
    test("update_skill using another tenant's skill id → not_found (no cross-tenant update)", async () => {
      // Seed a skill in tenant B via the admin/REST service.
      const bSkill = await createSkill(
        {
          tenant_id: tenantBId,
          input: { scope: "global", title: "Tenant B Only Skill", body: "Belongs to tenant B" },
        },
        testDb.db,
      );

      // Tenant A tries to update tenant B's skill — must get not_found, not a
      // cross-tenant mutation (engineClient filters by tenant_id).
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

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests (e)–(f): stub DB — no Postgres required
// ─────────────────────────────────────────────────────────────────────────────

// ─── (e) RBAC credential ceiling ─────────────────────────────────────────────
//
// The credential ceiling is a pure function over principal.scopes evaluated
// inside can() in the RBAC evaluator. No DB query is issued before the ceiling
// fires, so a stub DB is sufficient for these deny tests.
//
// The allow tests use roles: ["admin"] which short-circuits can() before any DB
// query (hasBuiltinAdminRole is also pure), so the stub DB covers those too.

describe("(e) RBAC credential ceiling — skill / knowledge tools", () => {
  // A shared registry — built once, reused across tests in this describe.
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
    // Exactly one POLICY_DENIED audit row — emitted by the dispatcher.
    // Zero APPROVAL_REQUESTED rows: RBAC fires first so the policy gate
    // is never reached for the denied principal.
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

  test("[skill:write] scoped admin key is NOT ceiling-denied for create_skill — ceiling passes, dispatch reaches the executor", async () => {
    // Required permission for create_skill is "skill:write".
    // The ceiling only denies when required permission is absent from the key's scopes.
    // With scopes: ["skill:write"] and permission "skill:write", the ceiling
    // does NOT fire — the admin role then grants access. On MCP the confirm
    // gate collapses to `proceed` (the client's native destructiveHint dialog
    // is the human gate), so the call passes RBAC + policy and reaches the
    // executor. The stub DB has no skills table, so execution fails with
    // `tool_execute_failed` — proof it got PAST RBAC, which is what this pins.
    //
    // Args must satisfy create_skill's own schema (title + body are required):
    // the dispatcher canonicalizes args through the descriptor's schema BEFORE
    // the policy gate runs, so an empty payload never reaches policyDecide at
    // all — it fails canonicalization with invalid_args first. That ordering
    // is orthogonal to the ceiling this test is pinning, so give it a valid
    // payload to actually exercise the ceiling → policy path.
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

    // Must NOT be policy_denied — the credential ceiling allows skill:write keys
    // to exercise skill:write operations. Reaching the executor (any non-denial
    // outcome) confirms RBAC passed.
    expect(envelope.status).toBe("error");
    if (envelope.status === "error") {
      expect(envelope.error_code).not.toBe("policy_denied");
    }
    const denied = capture.inserts.filter((r) => r.action === AuditAction.POLICY_DENIED);
    expect(denied.length).toBe(0);
  });

  test("[knowledge:write] scoped admin key is NOT ceiling-denied for create_knowledge_source", async () => {
    const { db, capture } = makeStubDb();
    const principal = makeTestPrincipal({ scopes: ["knowledge:write"], roles: ["admin"] });

    // create_knowledge_source's schema requires mode='inline' to carry name +
    // content (its `.refine()`) — same canonicalize-before-policy ordering as
    // create_skill above, so the ceiling probe needs a schema-valid payload.
    const envelope = await dispatchTool(
      { registry, db, principal },
      {
        surface: "mcp",
        name: "create_knowledge_source",
        args: { mode: "inline", name: "Ceiling Probe KS", content: "probe content" },
      },
    );

    // Ceiling passes → reaches the executor (MCP takes no confirm; the client
    // gate is the human step). Not a denial is the pin.
    expect(envelope.status).toBe("error");
    if (envelope.status === "error") {
      expect(envelope.error_code).not.toBe("policy_denied");
    }
    const denied = capture.inserts.filter((r) => r.action === AuditAction.POLICY_DENIED);
    expect(denied.length).toBe(0);
  });
});

// ─── (f) confirm-gate on MCP surface ─────────────────────────────────────────
//
// tenant_write tools advertise `destructiveHint:true` (mcp/capabilities/
// tool-meta.ts), so over MCP a trusted client (claude.ai, ChatGPT) renders a
// blocking, per-call, model-unbypassable approval dialog BEFORE the call ever
// reaches the engine — empirically verified against both clients. The server
// therefore takes NO confirm on `surface:"mcp"` (`tools/policy.ts` collapses
// `confirm_before_execution` → `proceed`): a second server gate would be
// redundant and, since in-band MCP elicitation is advertised-but-unfulfilled,
// has no grant channel. So a bare MCP dispatch of a tenant_write:
//   - does NOT return `needs_confirm`,
//   - mints NO approval (zero APPROVAL_REQUESTED rows),
//   - proceeds to the executor (which fails `tool_execute_failed` on the stub
//     DB — proof it got past the gate).
// The chat surface is unchanged and STILL gates via `ask_user_confirm` — pinned
// in `tools/tests/policy-decide.test.ts` and `tools/tests/dispatcher.test.ts`.
//
// An admin principal with wildcard scopes passes RBAC without any DB queries
// (credential ceiling: * → no ceiling; admin role → short-circuit allow), so
// the only thing between dispatch and the executor is the (now absent) gate.

describe("(f) confirm-gate on MCP surface", () => {
  const registry = buildRegistry([conversationToolProvider]);
  const adminPrincipal = makeTestPrincipal({ scopes: ["*"], roles: ["admin"] });

  test("create_skill dispatched on MCP proceeds directly — no needs_confirm, no minted approval", async () => {
    const { db, capture } = makeStubDb();

    // Schema-valid args (title + body) so the call clears canonicalization
    // and actually reaches the policy gate instead of failing invalid_args.
    const envelope = await dispatchTool(
      { registry, db, principal: adminPrincipal },
      {
        surface: "mcp",
        name: "create_skill",
        args: { scope: "global", title: "Confirm Gate Probe", body: "probe body" },
      },
    );

    // The client's destructiveHint dialog is the gate — the server proceeds.
    expect(envelope.status).not.toBe("needs_confirm");
    // NOT gated away by policy: it reached the executor (stub has no skills
    // table → tool_execute_failed), never a policy_denied.
    if (envelope.status === "error") {
      expect(envelope.error_code).not.toBe("policy_denied");
    }
    // Zero approvals minted: MCP takes no server-side confirm.
    const approvalRows = capture.inserts.filter((r) => r.action === AuditAction.APPROVAL_REQUESTED);
    expect(approvalRows.length).toBe(0);
  });

  test("delete_skill dispatched on MCP proceeds directly — no needs_confirm, no minted approval", async () => {
    const { db, capture } = makeStubDb();

    const envelope = await dispatchTool(
      { registry, db, principal: adminPrincipal },
      {
        surface: "mcp",
        name: "delete_skill",
        // Valid UUID arg so the descriptor's resource() extractor can run.
        args: { id: MISSING_UUID },
      },
    );

    expect(envelope.status).not.toBe("needs_confirm");
    if (envelope.status === "error") {
      expect(envelope.error_code).not.toBe("policy_denied");
    }
    const approvalRows = capture.inserts.filter((r) => r.action === AuditAction.APPROVAL_REQUESTED);
    expect(approvalRows.length).toBe(0);
  });
});
