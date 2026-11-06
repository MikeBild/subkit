import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import { auditLog } from "../db/schema/audit.ts";
import { tenants } from "../db/schema/identity.ts";
import { conversations, executions, workflows, workflowVersions } from "../db/schema/index.ts";
import { getMockProvider } from "../llm/mock-provider.ts";
import { TEST_HUMAN_ANSWER } from "../test-helpers/answer-actor.ts";
import { tryFastPath } from "./fast-path.ts";
import {
  conversationId,
  makeParams,
  makePrincipal,
  remote,
  seedMinimalWorkflow,
  tdb,
  tenantId,
  useFastPathSetup,
} from "./fast-path-fixtures.ts";
import { renderRunOutput } from "./fast-path-render.ts";
import { listConversations } from "./service/lifecycle.ts";

useFastPathSetup();

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
    expect(result?.assistant_text).not.toContain("failed");
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
      .where(
        and(
          eq(auditLog.action, AuditAction.POLICY_DENIED),
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.resource_id, conversationId),
        ),
      );
    expect(audit.length).toBeGreaterThan(0);
    expect(
      audit.some(
        (row) => (row.metadata as Record<string, unknown>)?.permission === "workflow:read",
      ),
    ).toBe(true);
  });
});
