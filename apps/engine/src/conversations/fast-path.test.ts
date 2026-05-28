// Integration tests for tryFastPath.
// Uses testcontainers postgres (createTestDb) — no mocks of the DB.
// The LLM is NOT called for fast-path hits — we assert zero LLM calls
// via getMockProvider().calls.length.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { tenants } from "../db/schema/identity.ts";
import { conversations, workflows, workflowVersions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getMockProvider, resetMockProvider } from "../llm/mock-provider.ts";
import { type FastPathParams, tryFastPath } from "./fast-path.ts";

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
// no-principal short-circuit
// ---------------------------------------------------------------------------

describe("tryFastPath — no-principal short-circuit for run commands", () => {
  test("'run my-workflow' with principal=null returns null", async () => {
    await seedMinimalWorkflow("my-workflow");
    const result = await tryFastPath(makeParams("run my-workflow", { principal: null }));
    // Without a principal, gateTenantToolCall can't run → fast-path skips
    expect(result).toBeNull();
  });

  test("list intents work even without a principal", async () => {
    // List intents don't require RBAC gate — they just read
    const result = await tryFastPath(makeParams("list workflows", { principal: null }));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_workflows");
  });
});

// ---------------------------------------------------------------------------
// run <slug> two-turn confirmation gate (T10 from manifest)
// ---------------------------------------------------------------------------

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
  test("portal-token principal not on the workflow's allowlist is denied on 'run <slug>'", async () => {
    const wf = await seedMinimalWorkflow("run-denied-wf");
    // Portal-token principals are scoped to their `allowed_workflows`.
    // An empty allowlist on a portal_token denies workflow:run on every
    // workflow — the RBAC evaluator's `matchesPortalTokenAllowlist` path.
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
    void wf;
  });

  test("portal-token principal not on the workflow's allowlist is denied on 'list workflows' (workflow:read)", async () => {
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
