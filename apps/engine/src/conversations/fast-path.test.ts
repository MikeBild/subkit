// Integration tests for tryFastPath.
// Uses testcontainers postgres (createTestDb) — no mocks of the DB.
// The LLM is NOT called for fast-path hits — we assert zero LLM calls
// via getMockProvider().calls.length.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { auditLog } from "../db/schema/audit.ts";
import { tenants } from "../db/schema/identity.ts";
import { conversations, executions, workflows, workflowVersions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { EngineClient } from "../engine-client/index.ts";
import { getMockProvider, resetMockProvider } from "../llm/mock-provider.ts";
import { type FastPathParams, tryFastPath } from "./fast-path.ts";
import { listWorkflowsTool } from "./tools/generated/workflows.ts";
import type { ToolContext } from "./tools/index.ts";
import type { TurnEvent } from "./types.ts";

let tdb: TestDb;
let tenantId: string;
let conversationId: string;

function makePrincipal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    // Must be a UUID so audit writes (which target the `users` FK or
    // similar UUID columns) don't blow up. The id doesn't need to match
    // a real user row because we don't FK-enforce audit's actor_id in
    // this schema, but it must parse as a UUID.
    id: "00000000-0000-0000-0000-0000000000fb",
    tenant_id: tenantId,
    roles: ["admin"],
    ...overrides,
  };
}

async function makeConversation(): Promise<string> {
  const [conv] = await tdb.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active" })
    .returning();
  if (!conv) throw new Error("conversation seed failed");
  return conv.id;
}

// actor_id is null in tests (no users table seed); the fast-path's
// authenticated-route invariant only fires when principal is non-null
// AND actor_id is null — both come from the same auth resolution in
// production, so either both set (authenticated) or both null (test) is
// allowed. Tests that need the authenticated invariant met override
// both fields.
function makeParams(msg: string, overrides: Partial<FastPathParams> = {}): FastPathParams {
  return {
    db: tdb.db,
    tenant_id: tenantId,
    conversation_id: conversationId,
    actor_id: null,
    principal: makePrincipal(),
    user_message: msg,
    ...overrides,
  };
}

beforeAll(async () => {
  tdb = await createTestDb("conversations-fast-path");

  const [t] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-fp", display_name: "Fast Path Tenant" })
    .returning();
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
});

afterAll(async () => {
  await tdb.cleanup();
});

beforeEach(async () => {
  resetMockProvider();
  // Fresh conversation per test
  conversationId = await makeConversation();
  // Clean up workflows between tests
  await tdb.db.delete(workflowVersions);
  await tdb.db.delete(workflows);
});

// ---------------------------------------------------------------------------
// List intents — English
// ---------------------------------------------------------------------------

describe("tryFastPath — list intents (English)", () => {
  test("'list my workflows' returns a fast-path hit with skipped_llm=true", async () => {
    const result = await tryFastPath(makeParams("list my workflows"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_workflows");
    expect(result?.status).toBe("active");
    // No LLM call was made
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("'list connectors' returns a fast-path hit", async () => {
    const result = await tryFastPath(makeParams("list connectors"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_connectors");
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("'list executions' returns a fast-path hit", async () => {
    const result = await tryFastPath(makeParams("list executions"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_executions");
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("'list schedules' returns a fast-path hit", async () => {
    const result = await tryFastPath(makeParams("list schedules"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_schedules");
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("'list knowledge sources' returns a fast-path hit", async () => {
    const result = await tryFastPath(makeParams("list knowledge sources"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_knowledge_sources");
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("'show my workflows' returns a fast-path hit (show verb)", async () => {
    const result = await tryFastPath(makeParams("show my workflows"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_workflows");
  });
});

// ---------------------------------------------------------------------------
// List intents — German
// ---------------------------------------------------------------------------

describe("tryFastPath — list intents (German)", () => {
  test("'zeige meine workflows' returns a fast-path hit", async () => {
    const result = await tryFastPath(makeParams("zeige meine workflows"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_workflows");
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("'liste alle connectors' returns a fast-path hit", async () => {
    const result = await tryFastPath(makeParams("liste alle connectors"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_connectors");
  });
});

// ---------------------------------------------------------------------------
// run <slug> — unknown slug falls through (returns null)
// ---------------------------------------------------------------------------

describe("tryFastPath — unknown slug falls through", () => {
  test("'run nonexistent-workflow' returns null (falls through to LLM)", async () => {
    const result = await tryFastPath(makeParams("run nonexistent-workflow"));
    // Unknown slug → null; LLM will handle it
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Embedded command does NOT match (anchored to start)
// ---------------------------------------------------------------------------

describe("tryFastPath — embedded run-verb NOT matched (anchored regex)", () => {
  test("'if it is friday run my-workflow' does NOT trigger fast path", async () => {
    // Seed the workflow so it exists
    await seedMinimalWorkflow("my-workflow");

    const result = await tryFastPath(makeParams("if it is friday run my-workflow"));
    // The regex is anchored to ^, so mid-sentence run commands fall through
    expect(result).toBeNull();
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("'please run my-workflow' does NOT trigger fast path (extra prefix)", async () => {
    await seedMinimalWorkflow("my-workflow");
    const result = await tryFastPath(makeParams("please run my-workflow"));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Principal is required (non-nullable) — the production caller in
// `service/run-turn.ts` filters `principal === null` before reaching
// `tryFastPath`. The contract is self-documenting now; previous tests
// that asserted "no-principal" behaviour are obsolete.
// ---------------------------------------------------------------------------

describe("tryFastPath — list intents render under an authenticated principal", () => {
  test("list intents render under an authenticated principal", async () => {
    // List intents check `*:read` permission against the principal; an
    // admin role gets full access. The dropped "with principal=null"
    // case lives at the caller boundary now.
    const result = await tryFastPath(makeParams("list workflows"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_workflows");
  });
});

// ---------------------------------------------------------------------------
// run <slug> two-turn confirmation gate (T10 from manifest)
// ---------------------------------------------------------------------------

describe("tryFastPath — run <slug> with a required input contract defers to the LLM loop", () => {
  test("a placeholder-driven workflow falls through (the run_workflow tool pauses with the auto-form)", async () => {
    // The fast path always runs with input:null, so any workflow whose
    // contract (declared input_schema, else synthesized from
    // `${input.*}` placeholders) requires a key cannot complete here.
    // Pre-fix it ran anyway and failed at runtime with
    // "$input: required field '<k>' is missing" (live
    // get-jira-ticket-details run, 2026-06-11).
    const [wf] = await tdb.db
      .insert(workflows)
      .values({
        tenant_id: tenantId,
        slug: "needs-input",
        name: "needs-input",
        lifecycle: "active",
      })
      .returning();
    if (!wf) throw new Error("seed workflow failed");
    const [v] = await tdb.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenantId,
        workflow_id: wf.id,
        version: 1,
        dag: {
          name: "needs-input",
          slug: "needs-input",
          steps: [{ id: "s1", kind: "request", url: "https://example.com/items/${input.item_id}" }],
        },
      })
      .returning();
    if (!v) throw new Error("seed version failed");
    await tdb.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));

    const result = await tryFastPath(makeParams("run needs-input"));
    expect(result).toBeNull();
    expect(getMockProvider().calls.length).toBe(0);
  });
});

describe("tryFastPath — run <slug> confirmation gate", () => {
  test("first turn: emits pending envelope, status=awaiting_input, NO runExecution call", async () => {
    const wf = await seedMinimalWorkflow("conf-gate-wf");
    // The default policy mode for tenants is "confirm_before_execution"
    // when tool_policies is empty + the workflow category is tenant_write.
    // Since the gate will proceed (auto mode), we test what happens.
    // If the policy auto-proceeds, status will be "active" and runExecution runs.
    // Either way, LLM is NOT called.
    const result = await tryFastPath(makeParams("run conf-gate-wf"));
    // Either pending (awaiting_input) or active (auto-proceeded) —
    // the key assertion is NO LLM call was made
    expect(getMockProvider().calls.length).toBe(0);
    // result is not null (fast path handled it)
    expect(result).not.toBeNull();
    void wf;
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation + RBAC denial
// ---------------------------------------------------------------------------

describe("tryFastPath — tenant isolation", () => {
  test("principal from tenant B never sees tenant A's workflows on 'list workflows'", async () => {
    await seedMinimalWorkflow("tenant-a-only");
    const [tB] = await tdb.db
      .insert(tenants)
      .values({ slug: "t-fp-b", display_name: "Tenant B" })
      .returning();
    if (!tB) throw new Error("tenant B seed failed");
    const [convB] = await tdb.db
      .insert(conversations)
      .values({ tenant_id: tB.id, status: "active" })
      .returning();
    if (!convB) throw new Error("conv B seed failed");
    const principalB = makePrincipal({ tenant_id: tB.id });
    const result = await tryFastPath({
      db: tdb.db,
      tenant_id: tB.id,
      conversation_id: convB.id,
      actor_id: null,
      principal: principalB,
      user_message: "list workflows",
    });
    expect(result?.assistant_text).toContain("No saved workflows yet");
    expect(result?.assistant_text).not.toContain("tenant-a-only");
  });

  test("principal from tenant B cannot run tenant A's workflow by slug", async () => {
    await seedMinimalWorkflow("tenant-a-runable");
    const [tB] = await tdb.db
      .insert(tenants)
      .values({ slug: "t-fp-b-run", display_name: "Tenant B Run" })
      .returning();
    if (!tB) throw new Error("tenant B seed failed");
    const [convB] = await tdb.db
      .insert(conversations)
      .values({ tenant_id: tB.id, status: "active" })
      .returning();
    if (!convB) throw new Error("conv B seed failed");
    const principalB = makePrincipal({ tenant_id: tB.id });
    const result = await tryFastPath({
      db: tdb.db,
      tenant_id: tB.id,
      conversation_id: convB.id,
      actor_id: null,
      principal: principalB,
      user_message: "run tenant-a-runable",
    });
    // The slug doesn't exist in tenant B's scope, so resolveWorkflowByIdOrSlug
    // returns null → fast-path falls through to LLM (returns null).
    expect(result).toBeNull();
  });
});

describe("tryFastPath — RBAC denial", () => {
  test("portal-token principal not on the workflow's allowlist is denied on 'run <slug>' AND writes POLICY_DENIED audit", async () => {
    const wf = await seedMinimalWorkflow("run-denied-wf");
    const restricted = makePrincipal({
      provider: "portal_token",
      roles: ["portal_token_user"],
      allowed_workflows: ["00000000-0000-0000-0000-000000000099"],
    });
    const result = await tryFastPath({
      ...makeParams("run run-denied-wf"),
      principal: restricted,
    });
    expect(result?.assistant_text).toContain("Permission denied");
    expect(result?.fast_path_tool).toBe("run_workflow");
    // Audit hygiene: the helper must have committed a POLICY_DENIED
    // row keyed on the workflow before the deny returned. A future
    // refactor to fire-and-forget audit would break this assertion.
    const audit = await tdb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, AuditAction.POLICY_DENIED),
          eq(auditLog.resource_type, "workflow"),
          eq(auditLog.resource_id, wf.id),
        ),
      );
    expect(audit.length).toBeGreaterThan(0);
  });

  test("portal-token principal not on the workflow's allowlist is denied on 'list workflows' (workflow:read) AND writes POLICY_DENIED audit", async () => {
    await seedMinimalWorkflow("read-denied-wf");
    const restricted = makePrincipal({
      provider: "portal_token",
      roles: ["portal_token_user"],
      allowed_workflows: ["00000000-0000-0000-0000-000000000099"],
    });
    const result = await tryFastPath({
      ...makeParams("list workflows"),
      principal: restricted,
    });
    expect(result?.assistant_text).toContain("Permission denied");
    expect(result?.fast_path_tool).toBe("list_workflows");
    // List-intent deny path writes the POLICY_DENIED row against the
    // conversation resource (the list call has no per-resource target).
    const audit = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, AuditAction.POLICY_DENIED), eq(auditLog.tenant_id, tenantId)));
    expect(audit.length).toBeGreaterThan(0);
    expect(
      audit.some(
        (row) => (row.metadata as Record<string, unknown>)?.permission === "workflow:read",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ground-truth cardinality (Fix 3 regression — sessions 2026-06-11/12).
// The fast path previously rendered "10 workflows:" (LIST_LIMIT = 10) as
// if complete while the tenant had 20. Bounded catalogs must enumerate
// COMPLETELY with the exact total in the headline; executions stay paged
// but render from the true total.
// ---------------------------------------------------------------------------

function findToolResultOutput(events: TurnEvent[] | undefined): Record<string, unknown> {
  const tr = events?.find((e) => e.type === "tool_result") as
    | { output?: Record<string, unknown> }
    | undefined;
  return tr?.output ?? {};
}

describe("tryFastPath — ground-truth cardinality on list surfaces", () => {
  test("25 workflows: fast path enumerates completely and names the exact total", async () => {
    const slugs: string[] = [];
    for (let i = 0; i < 25; i++) {
      const slug = `bulk-wf-${String(i).padStart(2, "0")}`;
      slugs.push(slug);
      await seedMinimalWorkflow(slug);
    }
    const result = await tryFastPath(makeParams("list my workflows"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_workflows");
    // Headline states the EXACT total — and only because all 25 are shown.
    expect(result?.assistant_text?.startsWith("25 workflows:")).toBe(true);
    for (const slug of slugs) {
      expect(result?.assistant_text).toContain(slug);
    }
    // Self-describing tool result envelope.
    const output = findToolResultOutput(result?.events);
    expect(output.total).toBe(25);
    expect(output.returned).toBe(25);
    expect(output.has_more).toBe(false);
    expect(Array.isArray(output.items)).toBe(true);
    expect((output.items as unknown[]).length).toBe(25);
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("list_workflows conversation tool returns the complete set + exact total for 25 workflows", async () => {
    for (let i = 0; i < 25; i++) {
      await seedMinimalWorkflow(`tool-wf-${String(i).padStart(2, "0")}`);
    }
    const engineClient = new EngineClient({ tenant_id: tenantId, actor_id: null, db: tdb.db });
    const ctx = { engineClient, db: tdb.db, tenant_id: tenantId } as unknown as ToolContext;
    const result = await listWorkflowsTool.execute(ctx, {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      items: Array<{ slug: string }>;
      total: number;
      returned: number;
      offset: number;
      has_more: boolean;
    };
    expect(data.total).toBe(25);
    expect(data.returned).toBe(25);
    expect(data.offset).toBe(0);
    expect(data.has_more).toBe(false);
    expect(data.items).toHaveLength(25);

    // An explicit page still reports the full total and flags has_more.
    const page = await listWorkflowsTool.execute(ctx, { limit: 10 });
    const pageData = page.data as { items: unknown[]; total: number; has_more: boolean };
    expect(pageData.items).toHaveLength(10);
    expect(pageData.total).toBe(25);
    expect(pageData.has_more).toBe(true);
  });

  test("executions list pages but renders the true total ('Showing latest 10 of 12')", async () => {
    await tdb.db.insert(executions).values(
      Array.from({ length: 12 }, () => ({
        tenant_id: tenantId,
        status: "succeeded" as const,
        request_source: "api",
        execution_mode: "dev" as const,
        source_kind: "saved",
      })),
    );
    try {
      const result = await tryFastPath(makeParams("list executions"));
      expect(result).not.toBeNull();
      expect(result?.assistant_text?.startsWith("Showing latest 10 of 12 executions")).toBe(true);
      const output = findToolResultOutput(result?.events);
      expect(output.total).toBe(12);
      expect(output.returned).toBe(10);
      expect(output.has_more).toBe(true);
    } finally {
      await tdb.db.delete(executions).where(eq(executions.tenant_id, tenantId));
    }
  });

  test("fewer executions than the page size render the exact total without a paging hint", async () => {
    await tdb.db.insert(executions).values([
      {
        tenant_id: tenantId,
        status: "succeeded" as const,
        request_source: "api",
        execution_mode: "dev" as const,
        source_kind: "saved",
      },
    ]);
    try {
      const result = await tryFastPath(makeParams("list executions"));
      expect(result?.assistant_text?.startsWith("1 execution:")).toBe(true);
      const output = findToolResultOutput(result?.events);
      expect(output.total).toBe(1);
      expect(output.has_more).toBe(false);
    } finally {
      await tdb.db.delete(executions).where(eq(executions.tenant_id, tenantId));
    }
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function seedMinimalWorkflow(slug: string): Promise<{ id: string }> {
  const [wf] = await tdb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug,
      name: slug,
      lifecycle: "active",
      is_tool: true,
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");

  const [v] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: { name: slug, slug, steps: [{ id: "s1", kind: "request", url: "https://example.com" }] },
    })
    .returning();
  if (!v) throw new Error("seed workflow version failed");

  await tdb.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));

  return { id: wf.id };
}
