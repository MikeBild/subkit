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
  toolApprovals,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { EngineClient } from "../engine-client/index.ts";
import { databaseNow } from "../test-helpers/database-clock.ts";
import { createMockServer, jsonResponse, type MockServer } from "../test-helpers/mock-http.ts";
import { capturePreparedWorkflowBinding } from "../tools/prepared-workflow-approval.ts";
import { previewWorkflowAuthority } from "../workflows/execution-authorities.ts";
import { createEmptyDraftDocument } from "./authoring-state.ts";
import { resolveElicitationAndReactivate } from "./elicitations.ts";
import { type FastPathParams, tryFastPath } from "./fast-path.ts";
import { maybeAutoPersistFromElicitation } from "./persistence/auto-persist.ts";
import { decideToolMode, type ToolPolicies } from "./tool-policies.ts";
import { runWorkflowTool } from "./tools/generated/writes/run-workflow.ts";
import type { ToolContext } from "./tools/index.ts";
import type { TurnSignals } from "./tools/sdk-wrap/state.ts";
import { buildSyntheticWorkflowTools } from "./tools/sdk-wrap/synthetic-workflow-tools.ts";

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

async function fixture(
  options: {
    maxRuns?: number;
    expired?: boolean;
    readLabel?: boolean;
    inputRequired?: boolean;
    environment?: "dev" | "prod";
  } = {},
) {
  const environment = options.environment ?? "dev";
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
    ...(options.inputRequired
      ? {
          input_schema: {
            type: "object",
            required: ["title"],
            properties: { title: { type: "string" } },
          },
        }
      : {}),
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
        execution_environment: environment,
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
        execution_environment: environment,
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
  async function runTool(
    kind: "generic" | "synthetic",
    executeWrites?: boolean,
    policy: { permissionMode?: "auto" | "ask" | "plan"; toolPolicies?: ToolPolicies } = {},
  ) {
    const [conversation] = await tdb.db
      .insert(conversations)
      .values({ tenant_id: tenantId, status: "active" })
      .returning();
    if (!conversation) throw new Error("missing tool conversation");
    const ctx: ToolContext = {
      db: tdb.db,
      tenant_id: tenantId,
      conversation_id: conversation.id,
      actor_id: null,
      connector_id: null,
      workflow_id: workflowId,
      principal,
      permission_mode: policy.permissionMode ?? null,
      engineClient: new EngineClient({ tenant_id: tenantId, actor_id: actorId, db: tdb.db }),
      getDraft: () => createEmptyDraftDocument(),
      setDraft: async () => {},
      onLog: () => {},
    };
    if (kind === "generic") {
      return runWorkflowTool.execute(ctx, {
        workflow: workflowId,
        environment,
        ...(executeWrites === undefined ? {} : { execute_writes: executeWrites }),
      });
    }
    const signals: TurnSignals = {
      step: 0,
      toolChain: Promise.resolve(),
      toolInvocationCount: new Map(),
      toolLastErrorHash: new Map(),
      toolArgsRepeat: new Map(),
      toolValidationFingerprint: new Map(),
      toolErrorCodeRepeat: new Map(),
      totalLoopWarnings: 0,
      consecutiveFailures: 0,
      lastAssistantText: "",
      lastExecutionSuccess: null,
      pendingChildToolCallIds: [],
      pendingChildElicitationIds: [],
    };
    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal,
      ctx,
      signals,
      events: [],
      ...policy,
    });
    const execute = tools[`wf_${slug}`]?.execute;
    if (!execute) throw new Error("missing synthetic workflow tool");
    return execute({}, { toolCallId: "bounded-tool-run", messages: [], context: {} });
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
  async function submitGeneratedInput() {
    const [elicitation] = await tdb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.tenant_id, tenantId));
    if (!elicitation) throw new Error("missing generated input form");
    const output = { values: { title: "Report" } };
    const resolution = await resolveElicitationAndReactivate(
      {
        tenant_id: tenantId,
        conversation_id: elicitation.conversation_id,
        id: elicitation.id,
        output,
        decided_by: null,
      },
      tdb.db,
    );
    expect(resolution.kind).toBe("resolved");
    const [resolved] = await tdb.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, tenantId),
          eq(conversationElicitations.id, elicitation.id),
        ),
      );
    if (!resolved) throw new Error("missing resolved input form");
    return maybeAutoPersistFromElicitation({
      db: tdb.db,
      tenant_id: tenantId,
      conversation_id: resolved.conversation_id,
      actor_id: null,
      principal,
      answer_actor: { kind: "human", user_id: actorId, via: "chat" },
      elicitation: resolved,
      elicitation_output: output,
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
  async function confirmPrepared() {
    const [elicitation] = await tdb.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, tenantId),
          eq(conversationElicitations.tool_name, "ask_user_confirm"),
        ),
      );
    if (!elicitation) throw new Error("missing prepared approval");
    return maybeAutoPersistFromElicitation({
      db: tdb.db,
      tenant_id: tenantId,
      conversation_id: elicitation.conversation_id,
      actor_id: actorId,
      principal,
      answer_actor: { kind: "human", user_id: actorId, via: "chat" },
      elicitation,
      elicitation_output: { confirmed: true },
    });
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
    submitGeneratedInput,
    runTool,
    confirmPrepared,
  };
}

test("a held chat approval replays its exact prepared version once", async () => {
  const f = await fixture();
  const before = remote.callCount();
  await f.runTool("synthetic");
  expect(remote.callCount()).toBe(before);
  const result = await f.confirmPrepared();
  expect(result.synthetic_result?.ok).toBe(true);
  expect(remote.callCount()).toBe(before + 1);
  const rows = await f.rows();
  expect(rows).toHaveLength(2);
  expect(rows.every((run) => run.workflow_version_id === f.version.id)).toBe(true);
  await f.confirmPrepared();
  expect(remote.callCount()).toBe(before + 1);
});

test("activation after a held preview invalidates the chat approval without dispatch", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  const [version] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.tenant.id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: { ...f.definition, description: "Unreviewed replacement" },
    })
    .returning();
  if (!version) throw new Error("missing replacement version");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, f.workflow.id)));
  const before = remote.callCount();
  const result = await f.confirmPrepared();
  expect(result.synthetic_result?.error_code).toBe("prepared_workflow_changed");
  expect(remote.callCount()).toBe(before);
  expect(await f.rows()).toHaveLength(1);
  const denied = await tdb.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.reason, "prepared_workflow_changed")),
    );
  expect(denied).toHaveLength(1);
});

test("a legacy or unreadable held approval cannot inherit the latest version", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  await tdb.db
    .update(toolApprovals)
    .set({ preview_ciphertext: null, preview_iv: null, preview_auth_tag: null })
    .where(eq(toolApprovals.tenant_id, f.tenant.id));
  const before = remote.callCount();
  expect((await f.confirmPrepared()).synthetic_result?.error_code).toBe(
    "prepared_workflow_changed",
  );
  expect(remote.callCount()).toBe(before);
});

test("prepared provenance rejects different tenant, input, environment and live runs", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  const [run] = await f.rows();
  if (!run) throw new Error("missing preparation");
  const params = {
    db: tdb.db,
    tenant_id: f.tenant.id,
    execution_id: run.id,
    tool: `wf_${f.workflow.slug}`,
    execution_mode: "dev" as const,
    args: {},
  };
  expect((await capturePreparedWorkflowBinding(params)).workflow_version_id).toBe(f.version.id);
  const other = await fixture();
  for (const changed of [
    { tenant_id: other.tenant.id },
    { args: { recipient: "other" } },
    { execution_mode: "prod" as const },
    { tool: `wf_${other.workflow.slug}` },
  ]) {
    await expect(capturePreparedWorkflowBinding({ ...params, ...changed })).rejects.toThrow();
  }
  const live = await fixture({ maxRuns: 1 });
  await live.runTool("synthetic");
  const [liveRun] = await live.rows();
  if (!liveRun) throw new Error("missing live run");
  await expect(
    capturePreparedWorkflowBinding({
      ...params,
      tenant_id: live.tenant.id,
      execution_id: liveRun.id,
      tool: `wf_${live.workflow.slug}`,
    }),
  ).rejects.toThrow();
});

for (const kind of ["generic", "synthetic"] as const) {
  test(`${kind} workflow tool cannot use an expired local authority`, async () => {
    const f = await fixture({ maxRuns: 1, expired: true });
    const before = remote.callCount();
    await f.runTool(kind);
    expect(remote.callCount()).toBe(before);
    expect(await f.reserved()).toBe(0);
    expect((await f.rows())[0]).toMatchObject({
      hold_writes: true,
      execution_authority_id: null,
      workflow_version_id: f.version.id,
    });
  });

  test(`${kind} workflow tool automatically reserves a matching local authority`, async () => {
    const f = await fixture({ maxRuns: 2 });
    const before = remote.callCount();
    for (let index = 0; index < 2; index++) {
      const result = await f.runTool(kind);
      expect(result).toMatchObject({ ok: true });
    }
    expect(remote.callCount() - before).toBe(2);
    expect(await f.reserved()).toBe(2);
    expect((await f.rows()).every((row) => row.execution_authority_id === f.authority?.id)).toBe(
      true,
    );
    const decisions = await tdb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.tenant_id, f.tenant.id));
    expect(decisions).toHaveLength(0);
    if (kind === "synthetic") {
      const audit = await tdb.db.select().from(auditLog).where(eq(auditLog.tenant_id, f.tenant.id));
      const runs = audit.filter(
        (row) =>
          row.metadata !== null &&
          typeof row.metadata === "object" &&
          "via_action" in row.metadata &&
          row.metadata.via_action === "conversation.run_workflow",
      );
      expect(runs).toHaveLength(2);
      for (const run of runs) {
        expect(run.metadata).toMatchObject({
          workflow_version_id: f.version.id,
          execution_authority_id: f.authority?.id,
          hold_writes: false,
          writes_held: false,
        });
      }
    }
  });
}

test("production tool policy admits an existing local grant without a second gate", async () => {
  const f = await fixture({ maxRuns: 1, environment: "prod" });
  expect(
    decideToolMode({
      tool: "run_workflow",
      category: "tenant_write",
      input: { workflow: f.workflow.id, environment: "prod" },
      overrides: {},
      permission_mode: "auto",
    }).mode,
  ).toBe("no_confirm");
  const before = remote.callCount();
  await f.runTool("generic");
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  expect((await f.rows())[0]).toMatchObject({
    execution_mode: "prod",
    execution_authority_id: f.authority?.id,
  });
});

test("an ordinary production tool start without authority remains held", async () => {
  const f = await fixture({ environment: "prod" });
  const before = remote.callCount();
  await f.runTool("generic");
  expect(remote.callCount()).toBe(before);
  expect((await f.rows())[0]).toMatchObject({
    execution_mode: "prod",
    hold_writes: true,
    execution_authority_id: null,
  });
});

for (const permissionMode of ["ask", "plan"] as const) {
  test(`synthetic tools preserve ${permissionMode} despite an available standing grant`, async () => {
    const f = await fixture({ maxRuns: 1 });
    const before = remote.callCount();
    await f.runTool("synthetic", undefined, {
      permissionMode,
      toolPolicies: { [`wf_${f.workflow.slug}`]: "no_confirm" },
    });
    expect(remote.callCount()).toBe(before);
    expect(await f.reserved()).toBe(0);
    expect((await f.rows())[0]).toMatchObject({ hold_writes: true, execution_authority_id: null });
    const pending = await tdb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.tenant_id, f.tenant.id));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
  });
}

test("synthetic tools preserve an explicit per-workflow approval preference", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  await f.runTool("synthetic", undefined, {
    permissionMode: "auto",
    toolPolicies: { [`wf_${f.workflow.slug}`]: "confirm_before_execution" },
  });
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
  expect((await f.rows())[0]?.hold_writes).toBe(true);
});

test("generic, synthetic and fast-path starts share the same last-run reservation", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  await Promise.all([f.runTool("generic"), f.runTool("synthetic"), f.run()]);
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  const rows = await f.rows();
  expect(rows).toHaveLength(3);
  expect(rows.filter((row) => row.execution_authority_id === f.authority?.id)).toHaveLength(1);
  expect(rows.filter((row) => row.hold_writes)).toHaveLength(2);
});

test("generic workflow tool preserves an explicit preparation despite an available grant", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  await f.runTool("generic", false);
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
  expect((await f.rows())[0]?.hold_writes).toBe(true);
});

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
  const resumedEvents = await tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.action, "conversation.resumed")));
  expect(resumedEvents).toHaveLength(1);
  expect(resumedEvents[0]).toMatchObject({
    result: "success",
    reason: "workflow_input_submitted",
    metadata: { ok: false, preparation: true },
  });
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

test("a generated missing-input form preserves an explicit preparation request", async () => {
  const f = await fixture({ maxRuns: 1, inputRequired: true });
  const before = remote.callCount();
  await f.runTool("generic", false);
  expect(await f.rows()).toHaveLength(0);
  const result = await f.submitGeneratedInput();
  expect(result.synthetic_result?.data).toMatchObject({ preview: true, writes_held: true });
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
  expect((await f.rows())[0]).toMatchObject({ hold_writes: true, execution_authority_id: null });
});

test("a generated missing-input form keeps ordinary local authority discovery", async () => {
  const f = await fixture({ maxRuns: 1, inputRequired: true });
  const before = remote.callCount();
  await f.runTool("generic");
  expect(await f.rows()).toHaveLength(0);
  const result = await f.submitGeneratedInput();
  expect(result.synthetic_result?.data).toMatchObject({
    execution_authority_id: f.authority?.id,
    execute_writes: true,
  });
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  const audit = await tdb.db.select().from(auditLog).where(eq(auditLog.tenant_id, f.tenant.id));
  expect(audit.filter((row) => row.action.startsWith("approval."))).toHaveLength(0);
  expect(audit.filter((row) => row.reason === "workflow_input_requested")).toHaveLength(1);
  expect(audit.filter((row) => row.reason === "workflow_input_resolved")).toHaveLength(1);
});
