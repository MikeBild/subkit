import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { EMBEDDED_MIGRATIONS } from "../db/migrations/embedded.ts";
import { auditLog } from "../db/schema/audit.ts";
import { tenants } from "../db/schema/identity.ts";
import {
  conversationMessages,
  conversations,
  executions,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { EngineClient } from "../engine-client/index.ts";
import {
  loadSnapshotCoverage,
  loadTenantSummary,
  renderTenantSummaryBlock,
} from "../llm/core/tenant-summary.ts";
import { getMockProvider, resetMockProvider } from "../llm/mock-provider.ts";
import { TEST_HUMAN_ANSWER } from "../test-helpers/answer-actor.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createMockServer, jsonResponse, type MockServer } from "../test-helpers/mock-http.ts";
import {
  type FastPathParams,
  matchCategoryListIntent,
  matchListIntent,
  tryFastPath,
} from "./fast-path.ts";
import { renderRunOutput } from "./fast-path-render.ts";
import { loadEnumerationCoverage } from "./loop/enumeration-coverage.ts";
import { listConversations } from "./service/lifecycle.ts";
import { listWorkflowsTool } from "./tools/engine-api/workflows.ts";
import type { ToolContext } from "./tools/index.ts";
import type { TurnEvent } from "./types.ts";

let tdb: TestDb;
let tenantId: string;
let conversationId: string;
let remote: MockServer;

function makePrincipal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
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

function makeParams(msg: string, overrides: Partial<FastPathParams> = {}): FastPathParams {
  return {
    db: tdb.db,
    tenant_id: tenantId,
    conversation_id: conversationId,
    actor_id: null,
    principal: makePrincipal(),
    user_message: msg,
    answer_actor: TEST_HUMAN_ANSWER,
    ...overrides,
  };
}

beforeAll(async () => {
  tdb = await createTestDb("conversations-fast-path");
  remote = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true }));

  const [t] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-fp", display_name: "Fast Path Tenant" })
    .returning();
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
});

afterAll(async () => {
  await remote.close();
  await tdb.cleanup();
});

beforeEach(async () => {
  resetMockProvider();
  conversationId = await makeConversation();
  await tdb.db.delete(workflowVersions);
  await tdb.db.delete(workflows);
});

describe("tryFastPath — list intents (English)", () => {
  test("'list my workflows' returns a fast-path hit with skipped_llm=true", async () => {
    const result = await tryFastPath(makeParams("list my workflows"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_workflows");
    expect(result?.status).toBe("active");
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

  test("a fast-path answer leaves the conversation answered, not in progress", async () => {
    await tryFastPath(makeParams("list my workflows"));
    const rows = await listConversations({ tenant_id: tenantId }, tdb.db);
    const row = rows.find((r) => r.id === conversationId);
    expect(row?.last_message_role).toBe("assistant");
    expect(row?.outcome).toBe("answered");
  });

  test("the migration moves an existing fast-path tool row before its answer, and only that", async () => {
    const loopConversationId = await makeConversation();
    const base = getTestNow() - 60_000;
    const at = (s: number) => new Date(base + s * 1000);
    await tdb.db.insert(conversationMessages).values([
      {
        tenant_id: tenantId,
        conversation_id: conversationId,
        role: "user",
        content: { text: "list my workflows" },
        created_at: at(0),
      },
      {
        tenant_id: tenantId,
        conversation_id: conversationId,
        role: "assistant",
        content: { text: "none", fast_path: true },
        created_at: at(1),
      },
      {
        tenant_id: tenantId,
        conversation_id: conversationId,
        role: "tool",
        content: { tool: "list_workflows", output: {} },
        created_at: at(2),
      },
      {
        tenant_id: tenantId,
        conversation_id: loopConversationId,
        role: "user",
        content: { text: "go" },
        created_at: at(0),
      },
      {
        tenant_id: tenantId,
        conversation_id: loopConversationId,
        role: "assistant",
        content: {},
        created_at: at(1),
      },
      {
        tenant_id: tenantId,
        conversation_id: loopConversationId,
        role: "tool",
        content: { tool: "run_workflow", output: {} },
        created_at: at(2),
      },
    ]);
    const migration = EMBEDDED_MIGRATIONS.find((m) => m.tag === "0070_fast_path_answer_last");
    if (!migration) throw new Error("migration 0070 is not embedded");
    for (const statement of migration.statements) await tdb.db.execute(sql.raw(statement));
    const rows = await listConversations({ tenant_id: tenantId }, tdb.db);
    expect(rows.find((r) => r.id === conversationId)?.outcome).toBe("answered");
    expect(rows.find((r) => r.id === loopConversationId)?.outcome).toBe("in_progress");
  });
});

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

describe("tryFastPath — multi-catalog list intents", () => {
  test("'list my connectors and workflows and knowledge sources' renders all three deterministically", async () => {
    const result = await tryFastPath(
      makeParams("list my connectors and workflows and knowledge sources"),
    );
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_catalogs");
    expect(result?.status).toBe("active");
    expect(getMockProvider().calls.length).toBe(0);
    const reply = result?.assistant_text ?? "";
    expect(reply.toLowerCase()).toContain("connector");
    expect(reply.toLowerCase()).toContain("workflow");
    expect(reply.toLowerCase()).toContain("knowledge");
  });

  test("'list my workflows and connectors' (informal, two catalogs) hits the fast path", async () => {
    const result = await tryFastPath(makeParams("list my workflows and connectors"));
    expect(result?.fast_path_tool).toBe("list_catalogs");
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("a single catalog still routes to its own renderer, not list_catalogs", async () => {
    const result = await tryFastPath(makeParams("list my workflows"));
    expect(result?.fast_path_tool).toBe("list_workflows");
  });

  test("multi-catalog with extra prose falls through to the LLM (null)", async () => {
    const result = await tryFastPath(
      makeParams("list my workflows and connectors and explain them"),
    );
    expect(result).toBeNull();
  });
});

describe("tryFastPath — unknown slug falls through", () => {
  test("'run nonexistent-workflow' returns null (falls through to LLM)", async () => {
    const result = await tryFastPath(makeParams("run nonexistent-workflow"));
    expect(result).toBeNull();
  });
});

describe("tryFastPath — embedded run-verb NOT matched (anchored regex)", () => {
  test("'if it is friday run my-workflow' does NOT trigger fast path", async () => {
    await seedMinimalWorkflow("my-workflow");

    const result = await tryFastPath(makeParams("if it is friday run my-workflow"));
    expect(result).toBeNull();
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("'please run my-workflow' does NOT trigger fast path (extra prefix)", async () => {
    await seedMinimalWorkflow("my-workflow");
    const result = await tryFastPath(makeParams("please run my-workflow"));
    expect(result).toBeNull();
  });
});

describe("tryFastPath — list intents render under an authenticated principal", () => {
  test("list intents render under an authenticated principal", async () => {
    const result = await tryFastPath(makeParams("list workflows"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_workflows");
  });
});

describe("tryFastPath — run <slug> with a required input contract defers to the LLM loop", () => {
  test("a placeholder-driven workflow falls through (the run_workflow tool pauses with the auto-form)", async () => {
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
          steps: [
            {
              id: "s1",
              kind: "request",
              url: `https://example.com/items/\${input.item_id}`,
            },
          ],
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

describe("tryFastPath — read-only run <slug>", () => {
  test("a read-only workflow completes without a confirmation or LLM call", async () => {
    const wf = await seedMinimalWorkflow("read-only-wf");
    const before = remote.callCount();
    const result = await tryFastPath(makeParams("run read-only-wf"));
    expect(getMockProvider().calls.length).toBe(0);
    expect(result?.status).toBe("active");
    expect(remote.callCount() - before).toBe(1);
    const rows = await tdb.db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, tenantId), eq(executions.workflow_id, wf.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("succeeded");
  });
});

describe("renderRunOutput", () => {
  test("a flat scalar object renders as a key: value bullet list, no JSON fence", () => {
    const out = renderRunOutput({ min_temp: 16.9, max_temp: 20.9, city: "Berlin" });
    expect(out).toBe("- min_temp: 16.9\n- max_temp: 20.9\n- city: Berlin");
    expect(out).not.toContain("```");
  });

  test("a plain string renders directly", () => {
    expect(renderRunOutput("done")).toBe("done");
  });

  test("scalars render as their string form", () => {
    expect(renderRunOutput(42)).toBe("42");
    expect(renderRunOutput(true)).toBe("true");
  });

  test("a nested object falls back to a fenced JSON block", () => {
    const out = renderRunOutput({ a: { b: 1 } });
    expect(out).toContain("```json");
    expect(out).toContain('"b": 1');
  });

  test("an array falls back to a fenced JSON block", () => {
    const out = renderRunOutput([1, 2, 3]);
    expect(out).toContain("```json");
  });

  test("null / undefined / empty output returns null so the caller uses a fallback line", () => {
    expect(renderRunOutput(null)).toBeNull();
    expect(renderRunOutput(undefined)).toBeNull();
    expect(renderRunOutput({})).toBeNull();
    expect(renderRunOutput([])).toBeNull();
    expect(renderRunOutput("   ")).toBeNull();
  });

  test("never emits the broken empty-version token or a step trace", () => {
    const out = renderRunOutput({ temp: 20 }) ?? "";
    expect(out).not.toContain("(v)");
    expect(out).not.toContain("succeeded");
    expect(out).not.toMatch(/\(transform\)|\(request\)/);
  });
});

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
      answer_actor: TEST_HUMAN_ANSWER,
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
      answer_actor: TEST_HUMAN_ANSWER,
    });
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
    expect(result?.assistant_text?.startsWith("25 workflows:")).toBe(true);
    for (const slug of slugs) {
      expect(result?.assistant_text).toContain(slug);
    }
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

async function seedMinimalWorkflow(slug: string, category = "other"): Promise<{ id: string }> {
  const [wf] = await tdb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug,
      name: slug,
      category,
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
      dag: {
        name: slug,
        slug,
        steps: [{ id: "s1", kind: "request", method: "GET", url: remote.baseUrl }],
      },
    })
    .returning();
  if (!v) throw new Error("seed workflow version failed");

  await tdb.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));

  return { id: wf.id };
}

describe("matchCategoryListIntent", () => {
  test.each([
    ["Zeig mir die notion-Workflows und was sie tun", "notion"],
    ["zeige mir alle notion workflows", "notion"],
    ["Zeig mir die Workflows in @kategorie/notion", "notion"],
    ["Workflows in @kategorie/notion", "notion"],
    ["die workflows in notion?", "notion"],
    ["show me the notion workflows", "notion"],
    ["show the notion workflows and what they do", "notion"],
    ["workflows in @category/notion", "notion"],
    ["list workflows in the category radar", "radar"],
    ["Zeig mir die mission-control-Workflows", "mission-control"],
  ])("%s → %s", (text, category) => {
    expect(matchCategoryListIntent(text)).toBe(category);
  });

  test.each([
    "was machen die notion workflows mit meinen Daten?",
    "run notion-sync",
    "show me the notion workflows that failed yesterday",
  ])("%s → no category intent", (text) => {
    expect(matchCategoryListIntent(text)).toBeNull();
  });
});

async function workflowIdBySlug(slug: string): Promise<string> {
  const [row] = await tdb.db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.slug, slug)));
  if (!row) throw new Error(`no workflow ${slug}`);
  return row.id;
}

async function seedCategoryCatalog(): Promise<{ notion: string[] }> {
  for (let i = 0; i < 41; i++)
    await seedMinimalWorkflow(`aa-filler-${String(i).padStart(2, "0")}`, "aa-filler");
  const notion = ["notion-archive", "notion-digest", "notion-search", "notion-sync"];
  for (const slug of notion) await seedMinimalWorkflow(slug, "notion");
  await tdb.db
    .update(workflows)
    .set({ description: "Copies new Notion pages\ninto the archive." })
    .where(eq(workflows.id, await workflowIdBySlug("notion-archive")));
  await tdb.db
    .update(workflows)
    .set({ description: "Mails a weekly digest of edited pages." })
    .where(eq(workflows.id, await workflowIdBySlug("notion-digest")));
  await tdb.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "notion-sync",
        slug: "notion-sync",
        description: "Stale text a definition once carried.",
        steps: [{ id: "s1", kind: "request", method: "GET", url: remote.baseUrl }],
      },
    })
    .where(eq(workflowVersions.workflow_id, await workflowIdBySlug("notion-sync")));
  const gone = await seedMinimalWorkflow("notion-retired", "notion");
  await tdb.db
    .update(workflows)
    .set({ deleted_at: new Date(0) })
    .where(eq(workflows.id, gone.id));
  return { notion };
}

describe("tryFastPath — one catalog block", () => {
  test("the chip phrasing lists every member with what it does, without the LLM", async () => {
    const { notion } = await seedCategoryCatalog();
    const result = await tryFastPath(makeParams("Zeig mir die notion-Workflows und was sie tun"));
    expect(result).not.toBeNull();
    expect(result?.fast_path_tool).toBe("list_workflows");
    const text = result?.assistant_text ?? "";
    expect(text.startsWith("4 Workflows in **notion**:")).toBe(true);
    for (const slug of notion) expect(text).toContain(`- ${slug} (aktiv)`);
    expect(text).not.toContain("(active)");
    expect(text).not.toContain("notion-retired");
    expect(text).not.toContain("aa-filler");
    expect(text).toContain("- notion-archive (aktiv) — Copies new Notion pages into the archive.");
    expect(text).toContain("- notion-digest (aktiv) — Mails a weekly digest of edited pages.");
    expect(text).toContain("- notion-search (aktiv)\n");
    expect(text).not.toContain("Stale text a definition once carried.");
    const output = findToolResultOutput(result?.events);
    expect(output.category).toBe("notion");
    expect(output.total).toBe(4);
    expect(getMockProvider().calls.length).toBe(0);
  });

  test("asked in English, answered in English; a name that differs from the slug is shown", async () => {
    await seedCategoryCatalog();
    await tdb.db
      .update(workflows)
      .set({ name: "Notion full-text search", description: null })
      .where(eq(workflows.id, await workflowIdBySlug("notion-search")));
    const text =
      (await tryFastPath(makeParams("show me the notion workflows")))?.assistant_text ?? "";
    expect(text.startsWith("4 workflows in **notion**:")).toBe(true);
    expect(text).toContain("- notion-archive (active) — Copies new Notion pages into the archive.");
    expect(text).toContain("- notion-search (active) — Notion full-text search");
    expect(text).not.toContain("(aktiv)");
  });

  test("the count equals the category size list_workflows reports, on every phrasing", async () => {
    await seedCategoryCatalog();
    const engineClient = new EngineClient({ tenant_id: tenantId, actor_id: null, db: tdb.db });
    const ctx = { engineClient, db: tdb.db, tenant_id: tenantId } as unknown as ToolContext;
    const listed = await listWorkflowsTool.execute(ctx, { category: "notion" });
    const listedSlugs = (listed.data as { items: Array<{ slug: string }> }).items
      .map((i) => i.slug)
      .sort();
    expect(listedSlugs).toHaveLength(4);
    for (const phrase of [
      "Zeig mir die Workflows in @kategorie/notion",
      "show me the notion workflows",
      "workflows in @category/notion",
    ]) {
      const result = await tryFastPath(makeParams(phrase));
      const items = findToolResultOutput(result?.events).items as Array<{ slug: string }>;
      expect(items.map((i) => i.slug).sort()).toEqual(listedSlugs);
    }
  });

  test("every category the chip row shows answers with exactly its members", async () => {
    await seedCategoryCatalog();
    for (const slug of ["radar-collect", "radar-normalize", "radar-publish"])
      await seedMinimalWorkflow(slug, "radar");
    const rows = await tdb.db
      .select({ slug: workflows.slug, category: workflows.category })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenantId), isNull(workflows.deleted_at)));
    const members = new Map<string, string[]>();
    for (const { slug, category } of rows)
      members.set(category, [...(members.get(category) ?? []), slug]);
    const categories = [...members.keys()];
    expect(categories.length).toBeGreaterThanOrEqual(3);
    for (const category of categories) {
      const result = await tryFastPath(
        makeParams(`Zeig mir die Workflows in @kategorie/${category}`),
      );
      expect(result, `no answer for ${category}`).not.toBeNull();
      const output = findToolResultOutput(result?.events);
      const items = (output.items as Array<{ slug: string }>).map((i) => i.slug).sort();
      expect(items, category).toEqual((members.get(category) ?? []).sort());
      expect(output.total, category).toBe(members.get(category)?.length);
    }
  });

  test("the LLM path's snapshot names the block past the row cap and admits it is partial", async () => {
    await seedCategoryCatalog();
    const summary = await loadTenantSummary(tenantId, tdb.db);
    expect(summary.workflows.some((w) => w.slug.startsWith("notion-"))).toBe(false);
    const text = renderTenantSummaryBlock(summary) ?? "";
    expect(text).toContain("notion (4)");
    expect(text).toContain("PARTIAL LIVE LIST");
    expect(text).not.toContain("DO NOT call list_workflows");
    expect(await loadSnapshotCoverage(tenantId, tdb.db)).toEqual({
      workflows_complete: false,
      connectors_complete: true,
    });
  });

  test("an unknown category falls through to the LLM", async () => {
    await seedCategoryCatalog();
    expect(await tryFastPath(makeParams("Zeig mir die jira-Workflows"))).toBeNull();
    expect(await tryFastPath(makeParams("workflows in @kategorie/jira"))).toBeNull();
  });

  test("the plain list phrasing still lists the whole catalog", async () => {
    await seedCategoryCatalog();
    const result = await tryFastPath(makeParams("zeige alle workflows"));
    expect(result?.assistant_text?.startsWith("45 workflows:")).toBe(true);
    expect(findToolResultOutput(result?.events).category).toBeUndefined();
  });

  test("a word that is no category falls through without a denial or an audit row", async () => {
    await seedCategoryCatalog();
    const restricted = makePrincipal({
      provider: "portal_token",
      roles: ["portal_token_user"],
      allowed_workflows: ["00000000-0000-0000-0000-000000000099"],
    });
    const deniedListReads = async () =>
      (
        await tdb.db
          .select()
          .from(auditLog)
          .where(
            and(eq(auditLog.action, AuditAction.POLICY_DENIED), eq(auditLog.tenant_id, tenantId)),
          )
      ).filter((row) => (row.metadata as Record<string, unknown>)?.tool === "list_workflows")
        .length;
    const before = await deniedListReads();
    for (const [text, word] of [
      ["show me the failed workflows", "failed"],
      ["zeig mir die aktiven workflows", "aktiven"],
    ] as const) {
      expect(matchListIntent(text), text).toBeNull();
      expect(matchCategoryListIntent(text), text).toBe(word);
      expect(await tryFastPath({ ...makeParams(text), principal: restricted }), text).toBeNull();
    }
    expect(await deniedListReads()).toBe(before);
  });

  test("the enumeration steering sees a named workflow and a trimmed catalog", async () => {
    await seedCategoryCatalog();
    expect(
      await loadEnumerationCoverage(tenantId, "wie viele Schritte hat notion-sync?", tdb.db),
    ).toEqual({
      workflows_complete: false,
      connectors_complete: true,
      names_existing_workflow: true,
    });
    expect(
      (await loadEnumerationCoverage(tenantId, "Zeig mir die notion-Workflows", tdb.db))
        .names_existing_workflow,
    ).toBe(false);
    expect(
      (await loadEnumerationCoverage(tenantId, "workflow notion-retired", tdb.db))
        .names_existing_workflow,
    ).toBe(false);
  });

  test("a principal without workflow:read is denied and audited", async () => {
    await seedCategoryCatalog();
    const restricted = makePrincipal({
      provider: "portal_token",
      roles: ["portal_token_user"],
      allowed_workflows: ["00000000-0000-0000-0000-000000000099"],
    });
    const result = await tryFastPath({
      ...makeParams("Zeig mir die notion-Workflows"),
      principal: restricted,
    });
    expect(result?.assistant_text).toBe("Permission denied: workflow:read.");
    const audit = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, AuditAction.POLICY_DENIED), eq(auditLog.tenant_id, tenantId)));
    expect(
      audit.some(
        (row) =>
          (row.metadata as Record<string, unknown>)?.permission === "workflow:read" &&
          (row.metadata as Record<string, unknown>)?.tool === "list_workflows",
      ),
    ).toBe(true);
  });
});
