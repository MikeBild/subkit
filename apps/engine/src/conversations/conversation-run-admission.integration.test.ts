import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import {
  auditLog,
  conversationElicitations,
  conversations,
  conversationToolCalls,
  executions,
  tenants,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { databaseNow } from "../test-helpers/database-clock.ts";
import { createMockServer, jsonResponse, type MockServer } from "../test-helpers/mock-http.ts";
import { previewWorkflowAuthority } from "../workflows/execution-authorities.ts";
import { type FastPathParams, tryFastPath } from "./fast-path.ts";
import { maybeAutoPersistFromElicitation } from "./persistence/auto-persist.ts";

let tdb: TestDb;
let remote: MockServer;
let sequence = 0;
const actorId = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  tdb = await createTestDb("fast-path-authority");
  remote = await createMockServer((_, response) => jsonResponse(response, 200, { sent: true }));
});

afterAll(async () => {
  await remote.close();
  await tdb.cleanup();
});

async function fixture(options: { maxRuns?: number; expired?: boolean; readLabel?: boolean } = {}) {
  const slug = `fast-boundary-${++sequence}`;
  const [tenant] = await tdb.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!tenant) throw new Error("missing tenant");
  const [workflow] = await tdb.db
    .insert(workflows)
    .values({ tenant_id: tenant.id, slug, name: slug, lifecycle: "active", is_tool: true })
    .returning();
  if (!workflow) throw new Error("missing workflow");
  const tenantId = tenant.id;
  const workflowId = workflow.id;
  const definition = {
    name: slug,
    slug,
    steps: [
      {
        id: "send",
        kind: "request",
        method: "POST",
        url: `${remote.baseUrl}/messages`,
        body: { recipient: "reviewed@example.test" },
        ...(options.readLabel ? { side_effects: "read" } : {}),
      },
    ],
  };
  const [version] = await tdb.db
    .insert(workflowVersions)
    .values({ tenant_id: tenant.id, workflow_id: workflow.id, version: 1, dag: definition })
    .returning();
  if (!version) throw new Error("missing version");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, tenant.id), eq(workflows.id, workflow.id)));
  let authority: typeof workflowExecutionAuthorities.$inferSelect | undefined;
  if (options.maxRuns !== undefined) {
    const preview = await previewWorkflowAuthority(
      {
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        workflow_version_id: version.id,
        execution_environment: "dev",
      },
      tdb.db,
    );
    expect(preview.eligible_for_repeated_runs).toBe(true);
    const now = await databaseNow(tdb.db);
    // Human issuance is tested at the service/browser boundary. This fixture
    // installs its exact server-resolved result to exercise the real ingress.
    [authority] = await tdb.db
      .insert(workflowExecutionAuthorities)
      .values({
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        workflow_version_id: version.id,
        effect_manifest_digest: preview.digest,
        effect_manifest: { ...preview.manifest },
        execution_environment: "dev",
        target_constraints: {
          targets: preview.manifest.effects.flatMap((effect) =>
            effect.target ? [effect.target] : [],
          ),
        },
        valid_from: new Date(now.getTime() - 60_000),
        valid_until: new Date(now.getTime() + (options.expired ? -1_000 : 3_600_000)),
        max_runs: options.maxRuns,
        created_by: actorId,
      })
      .returning();
    if (!authority) throw new Error("missing authority");
  }
  const principal: ResolvedPrincipal = {
    provider: "test",
    kind: "user",
    id: actorId,
    tenant_id: tenant.id,
    roles: ["admin"],
  };
  async function run(surface: "chat" | "mcp" = "chat", command = "run") {
    const [conversation] = await tdb.db
      .insert(conversations)
      .values({ tenant_id: tenantId, status: "active" })
      .returning();
    if (!conversation) throw new Error("missing conversation");
    const params: FastPathParams = {
      db: tdb.db,
      tenant_id: tenantId,
      conversation_id: conversation.id,
      actor_id: null,
      principal,
      surface,
      answer_actor: { kind: "relay", reason: "model_tool_call" },
      user_message: `${command} ${slug}`,
    };
    return tryFastPath(params);
  }
  async function rows() {
    return tdb.db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, tenantId), eq(executions.workflow_id, workflowId)));
  }
  async function submitInput(executeWrites: boolean) {
    const [conversation] = await tdb.db
      .insert(conversations)
      .values({ tenant_id: tenantId, status: "awaiting_input" })
      .returning();
    if (!conversation) throw new Error("missing form conversation");
    const [elicitation] = await tdb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: tenantId,
        conversation_id: conversation.id,
        tool_name: "ask_user_form",
        summary: "Supply workflow input",
        input: {
          commit_intent: {
            kind: "run_workflow",
            description: "Use the supplied input",
            payload: { workflow_id: workflowId, environment: "dev", execute_writes: executeWrites },
          },
        },
        output: { values: { title: "Report" } },
        status: "resolved",
      })
      .returning();
    if (!elicitation) throw new Error("missing input form");
    return maybeAutoPersistFromElicitation({
      db: tdb.db,
      tenant_id: tenantId,
      conversation_id: conversation.id,
      actor_id: null,
      principal,
      answer_actor: { kind: "human", user_id: actorId, via: "chat" },
      elicitation,
      elicitation_output: elicitation.output,
    });
  }
  async function reserved() {
    if (!authority) throw new Error("no authority in fixture");
    const [row] = await tdb.db
      .select()
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, tenantId),
          eq(workflowExecutionAuthorities.id, authority.id),
        ),
      );
    return row?.reserved_runs;
  }
  async function activity() {
    return tdb.db
      .select({
        outcome: conversationToolCalls.outcome,
        approval_required: conversationToolCalls.approval_required,
      })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.tenant_id, tenantId));
  }
  return {
    tenant,
    workflow,
    version,
    authority,
    definition,
    run,
    rows,
    reserved,
    activity,
    submitInput,
  };
}

for (const surface of ["chat", "mcp"] as const) {
  test(`${surface}: unapproved writes are durably held, including an author-supplied read label`, async () => {
    const f = await fixture({ readLabel: true });
    const before = remote.callCount();
    const result = await f.run(surface);
    expect(result?.status).toBe("active");
    expect(result?.assistant_text).toContain("Nothing was written");
    expect(remote.callCount()).toBe(before);
    const rows = await f.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hold_writes: true,
      workflow_version_id: f.version.id,
      execution_authority_id: null,
    });
    const event = result?.events.find((entry) => entry.type === "tool_result");
    if (event?.type !== "tool_result") throw new Error("missing result");
    expect(event.output).toMatchObject({ ok: false, writes_held: true, preview: true });
    expect(await f.activity()).toEqual([{ outcome: "ok", approval_required: false }]);
  });
}

test("a German start explains the held preparation in German", async () => {
  const f = await fixture();
  const before = remote.callCount();
  const result = await f.run("chat", "starte");
  expect(result?.assistant_text).toContain("Es wurde nichts geschrieben");
  expect(result?.assistant_text).toContain("Ausführungsfreigabe");
  expect(result?.assistant_text).not.toContain("Nothing was written");
  expect(remote.callCount()).toBe(before);
});

test("matching authority runs twice without a new gate, then holds the exhausted third run", async () => {
  const f = await fixture({ maxRuns: 2 });
  const before = remote.callCount();
  for (const surface of ["chat", "mcp"] as const) {
    const result = await f.run(surface);
    expect(result?.status).toBe("active");
    expect(result?.assistant_text).not.toContain("Nothing was written");
  }
  expect(remote.callCount() - before).toBe(2);
  expect(await f.reserved()).toBe(2);
  const third = await f.run();
  expect(third?.assistant_text).toContain("Nothing was written");
  expect(remote.callCount() - before).toBe(2);
  const rows = await f.rows();
  expect(rows.filter((row) => row.execution_authority_id === f.authority?.id)).toHaveLength(2);
  expect(rows.filter((row) => row.hold_writes)).toHaveLength(1);
});

test("parallel starts cannot spend the last authorized run twice", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  await Promise.all([f.run("chat"), f.run("mcp")]);
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  const rows = await f.rows();
  expect(rows).toHaveLength(2);
  expect(rows.filter((row) => row.hold_writes)).toHaveLength(1);
});

test("expired authority cannot release a write", async () => {
  const f = await fixture({ maxRuns: 1, expired: true });
  const before = remote.callCount();
  expect((await f.run())?.assistant_text).toContain("Nothing was written");
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
});

test("revoked authority cannot release a write", async () => {
  const f = await fixture({ maxRuns: 1 });
  if (!f.authority) throw new Error("missing authority");
  await tdb.db
    .update(workflowExecutionAuthorities)
    .set({ revoked_at: await databaseNow(tdb.db), revoked_by: actorId })
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, f.tenant.id),
        eq(workflowExecutionAuthorities.id, f.authority.id),
      ),
    );
  const before = remote.callCount();
  expect((await f.run())?.assistant_text).toContain("Nothing was written");
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
});

test("a newer workflow version cannot inherit the old authority", async () => {
  const f = await fixture({ maxRuns: 1 });
  const [next] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.tenant.id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: { ...f.definition, description: "New revision requires its own decision" },
    })
    .returning();
  if (!next) throw new Error("missing next version");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: next.id })
    .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, f.workflow.id)));
  const before = remote.callCount();
  expect((await f.run())?.assistant_text).toContain("Nothing was written");
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
  expect((await f.rows())[0]?.workflow_version_id).toBe(next.id);
});

test("a submitted input form cannot authorize writes through execute_writes=true", async () => {
  const f = await fixture();
  const before = remote.callCount();
  const result = await f.submitInput(true);
  expect(result.dispatched).toBe(true);
  expect(result.synthetic_result?.ok).toBe(false);
  expect(result.synthetic_result?.data).toMatchObject({
    preview: true,
    writes_held: true,
    execute_writes: false,
  });
  expect(remote.callCount()).toBe(before);
  expect((await f.rows())[0]).toMatchObject({ hold_writes: true, execution_authority_id: null });
  expect(await f.activity()).toEqual([{ outcome: "ok", approval_required: false }]);
  const approvalEvents = await tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.action, "approval.approved")));
  expect(approvalEvents).toHaveLength(0);
  const calls = await tdb.db
    .select()
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.tenant_id, f.tenant.id));
  expect(calls[0]?.confirmation_state).toBeNull();
});

test("submitted input uses an existing local authority without another decision", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  const result = await f.submitInput(true);
  expect(result.synthetic_result?.ok).toBe(true);
  expect(result.synthetic_result?.data).toMatchObject({
    execution_authority_id: f.authority?.id,
    execute_writes: true,
  });
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
});

test("an explicit preparation form does not spend an available live run", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  const result = await f.submitInput(false);
  expect(result.synthetic_result?.data).toMatchObject({ preview: true, writes_held: true });
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
});
