// Integration + unit tests for the skill MCP write tools.
//
// Coverage:
//  (a) create_skill  — skill row created, domain audit (skill.created),
//                      surface audit (conversation.create_skill), returned audit_log_id.
//  (b) update_skill  — patch applied; missing id → not_found.
//  (c) delete_skill  — deleted; missing id → not_found.
//  (d) tenant isolation — a skill from another tenant is not updatable/deletable.
//  (e) RBAC credential ceiling — a principal scoped to ["workflow:read"] is denied
//                      create_skill AND create_knowledge_source via the dispatcher
//                      credential ceiling; a ["skill:write"] / ["knowledge:write"]
//                      principal is NOT denied by the ceiling (ceiling passes, policy
//                      gate fires normally → needs_confirm, proving the gap fix).
//  (f) confirm-gate  — dispatching create_skill on the MCP surface without sk_confirm
//                      returns needs_confirm + APPROVAL_REQUESTED audit; delete_skill
//                      dispatched without sk_confirm also returns needs_confirm.
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
import { auditLog, tenants } from "../../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../../db/tests/setup.ts";
import { EngineClient } from "../../../../engine-client/index.ts";
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

  describe("(a) create_skill — happy path", () => {
    test("skill row created + domain audit (skill.created) + surface audit (conversation.create_skill) + audit_log_id returned", async () => {
      const ctx = makeCtx(tenantAId);
      const result = await createSkillTool.execute(ctx, {
        scope: "global",
        title: "Test Skill Alpha",
        body: "Guide body for testing create_skill",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const data = result.data as {
        created: boolean;
        skill: { id: string; title: string; tenant_id: string };
        audit_log_id: string;
      };
      expect(data.created).toBe(true);
      expect(data.skill.title).toBe("Test Skill Alpha");
      expect(data.skill.tenant_id).toBe(tenantAId);
      expect(typeof data.skill.id).toBe("string");
      expect(typeof data.audit_log_id).toBe("string");

      // Domain audit: skill.created emitted inside skillsSvc.createSkill.
      const domainRows = await testDb.db
        .select({ action: auditLog.action, resource_id: auditLog.resource_id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenantAId),
            eq(auditLog.action, AuditAction.SKILL_CREATED),
            eq(auditLog.resource_id, data.skill.id),
          ),
        );
      expect(domainRows.length).toBe(1);

      // Surface audit: conversation.create_skill emitted by the tool itself.
      const surfaceRows = await testDb.db
        .select({ id: auditLog.id, action: auditLog.action, resource_id: auditLog.resource_id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenantAId),
            eq(auditLog.action, "conversation.create_skill"),
            eq(auditLog.resource_id, data.skill.id),
          ),
        );
      expect(surfaceRows.length).toBe(1);

      // The returned audit_log_id must be the surface audit row's id.
      expect(surfaceRows[0]?.id).toBe(data.audit_log_id);
    });
  });

  // ─── (b) update_skill ───────────────────────────────────────────────────────

  describe("(b) update_skill", () => {
    test("happy path: title patch applied, audit_log_id returned", async () => {
      const ctx = makeCtx(tenantAId);

      const created = await createSkillTool.execute(ctx, {
        scope: "global",
        title: "Before Update",
        body: "Original body content",
      });
      expect(created.ok).toBe(true);
      const { skill: seedSkill } = created.data as { skill: { id: string } };

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

      const created = await createSkillTool.execute(ctx, {
        scope: "global",
        title: "To Be Deleted",
        body: "Ephemeral",
      });
      expect(created.ok).toBe(true);
      const { skill: toDelete } = created.data as { skill: { id: string } };

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
      // Seed a skill in tenant B.
      const ctxB = makeCtx(tenantBId);
      const created = await createSkillTool.execute(ctxB, {
        scope: "global",
        title: "Tenant B Only Skill",
        body: "Belongs to tenant B",
      });
      expect(created.ok).toBe(true);
      const { skill: bSkill } = created.data as { skill: { id: string } };

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
      const ctxB = makeCtx(tenantBId);
      const created = await createSkillTool.execute(ctxB, {
        scope: "global",
        title: "Tenant B Skill for Delete Guard",
        body: "Belongs to tenant B",
      });
      expect(created.ok).toBe(true);
      const { skill: bSkill } = created.data as { skill: { id: string } };

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

  test("[skill:write] scoped admin key is NOT ceiling-denied for create_skill — ceiling passes, policy gate fires → needs_confirm", async () => {
    // Required permission for create_skill is "skill:write".
    // The ceiling only denies when required permission is absent from the key's scopes.
    // With scopes: ["skill:write"] and permission "skill:write", the ceiling
    // does NOT fire — the admin role then grants access; policy → needs_confirm.
    //
    // Args must satisfy create_skill's own schema (title + body are required):
    // the dispatcher canonicalizes args through the descriptor's schema BEFORE
    // the policy gate runs, so an empty payload never reaches policyDecide at
    // all — it fails canonicalization with invalid_args first. That ordering
    // is orthogonal to the ceiling this test is pinning, so give it a valid
    // payload to actually exercise the ceiling → policy path.
    const { db } = makeStubDb();
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
    // to exercise skill:write operations. needs_confirm confirms RBAC passed.
    expect(envelope.status).toBe("needs_confirm");
  });

  test("[knowledge:write] scoped admin key is NOT ceiling-denied for create_knowledge_source", async () => {
    const { db } = makeStubDb();
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

    expect(envelope.status).toBe("needs_confirm");
  });
});

// ─── (f) confirm-gate ────────────────────────────────────────────────────────
//
// tenant_write tools require confirmation before execution on every surface.
// Under the current contract the gate MINTS AN UNGRANTED APPROVAL up front:
// `needs_confirm`'s envelope carries both a `tool_call_id` (the confirm/
// approval id a later `confirm_tool_call` re-issue TRIGGERS, never approves)
// and — when the engine has a `server.public_base_url` configured —
// an `approval_url`, the one channel a HUMAN uses to actually grant it. The
// dispatcher records APPROVAL_REQUESTED before returning the envelope; the
// `tool_approvals` row it mints is `granted_at: NULL` until a human decides
// (proved end-to-end, including the grant, in
// `mcp/tests/wf-confirm-loop.test.ts`).
//
// This stub-DB unit describe doesn't configure `server.public_base_url`, so
// `requestApproval` mints no portal link here (`approval_url` comes back
// null) — that half of the contract is covered by the integration test
// above. What this describe pins is the shape a bare dispatch call gets:
// needs_confirm + a tool_call_id + exactly one APPROVAL_REQUESTED audit row.
//
// An admin principal with wildcard scopes passes RBAC without any DB
// queries (credential ceiling: * → no ceiling; admin role → short-circuit allow).
// The stub DB captures the APPROVAL_REQUESTED insert so we can assert it.

describe("(f) confirm-gate on MCP surface", () => {
  const registry = buildRegistry([conversationToolProvider]);
  const adminPrincipal = makeTestPrincipal({ scopes: ["*"], roles: ["admin"] });

  test("create_skill dispatched on MCP without sk_confirm → needs_confirm + APPROVAL_REQUESTED audit", async () => {
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

    expect(envelope.status).toBe("needs_confirm");
    if (envelope.status === "needs_confirm") {
      expect(envelope.confirm.tool).toBe("create_skill");
      expect(typeof envelope.confirm.tool_call_id).toBe("string");
      // No `server.public_base_url` is configured in this unit describe, so
      // `requestApproval` mints no portal link — `approval_url` is null, not
      // absent-by-omission. A real link is proved end-to-end (grant included)
      // in `mcp/tests/wf-confirm-loop.test.ts`.
      expect(envelope.confirm.approval_url).toBeNull();
    }

    // The dispatcher emits APPROVAL_REQUESTED before returning needs_confirm,
    // and mints the approval UNGRANTED — nothing in this call can grant it.
    const approvalRows = capture.inserts.filter((r) => r.action === AuditAction.APPROVAL_REQUESTED);
    expect(approvalRows.length).toBe(1);
    // On MCP the resource_type is "mcp_tool_call".
    expect(approvalRows[0]?.resource_type).toBe("mcp_tool_call");
    if (envelope.status === "needs_confirm") {
      expect(approvalRows[0]?.resource_id).toBe(envelope.confirm.tool_call_id);
    }
  });

  test("delete_skill dispatched on MCP without sk_confirm → needs_confirm (force-confirmed like any tenant_write)", async () => {
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

    expect(envelope.status).toBe("needs_confirm");
    if (envelope.status === "needs_confirm") {
      expect(envelope.confirm.tool).toBe("delete_skill");
      expect(typeof envelope.confirm.tool_call_id).toBe("string");
      // No portal configured in this unit describe — see the comment above.
      expect(envelope.confirm.approval_url).toBeNull();
    }

    const approvalRows = capture.inserts.filter((r) => r.action === AuditAction.APPROVAL_REQUESTED);
    expect(approvalRows.length).toBe(1);
    if (envelope.status === "needs_confirm") {
      expect(approvalRows[0]?.resource_id).toBe(envelope.confirm.tool_call_id);
    }
  });
});
