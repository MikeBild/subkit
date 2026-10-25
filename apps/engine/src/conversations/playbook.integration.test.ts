import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import {
  auditLog,
  connectors,
  conversationDraftSnapshots,
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  executionSteps,
  executions,
  intakeItems,
  tenants,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { EngineClient } from "../engine-client/index.ts";
import { FROZEN_NOW, setTestNow } from "../test-helpers/determinism/clock.ts";
import { createEmptyDraftDocument } from "./authoring-state.ts";
import { createElicitation, resolveElicitation } from "./elicitations.ts";
import { buildMessages } from "./parts.ts";
import {
  forkPlaybookDocument,
  PlaybookConflictError,
  readPlaybook,
  settlePlaybookAtTurnEnd,
  updatePlaybook,
} from "./playbook.ts";
import {
  PlaybookDocumentSchema,
  type PlaybookPlan,
  type PlaybookStep,
} from "./playbook-contract.ts";
import type { PlaybookScope } from "./playbook-evidence.ts";
import { getConversation } from "./service/get.ts";
import type { ToolContext } from "./tools/index.ts";
import type { TurnSignals } from "./tools/sdk-wrap/state.ts";
import { wrapTools } from "./tools/sdk-wrap.ts";
import { boundForPersistence } from "./tools/truncate.ts";

let fixture: TestDb;
let tenantId: string;
let principal: ResolvedPrincipal;
let sequence = 0;
const timestamp = (offset = 0) => new Date(FROZEN_NOW + offset);
const actorId = "00000000-0000-4000-8000-000000000101";

beforeAll(async () => {
  setTestNow(() => FROZEN_NOW);
  fixture = await createTestDb("playbook_contract");
  const [tenant] = await fixture.db
    .insert(tenants)
    .values({ slug: "playbook-tests", display_name: "Playbook tests" })
    .returning();
  if (!tenant) throw new Error("missing tenant");
  tenantId = tenant.id;
  principal = {
    id: actorId,
    kind: "user",
    tenant_id: tenantId,
    roles: ["admin"],
    provider: "test",
  };
});
afterAll(async () => {
  setTestNow(null);
  await fixture?.cleanup();
});

async function scope(mode: "auto" | "off" = "auto"): Promise<PlaybookScope> {
  const [row] = await fixture.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active", playbook_mode: mode })
    .returning();
  if (!row) throw new Error("missing conversation");
  return { tenant_id: tenantId, conversation_id: row.id, principal };
}
function step(criterion: PlaybookStep["criterion"], evidence_ids: string[] = []): PlaybookStep {
  return {
    id: "check",
    label: "Prüfen",
    criterion,
    evidence_ids,
    depends_on: [],
    progress: "open",
    note: null,
    next_action: null,
  };
}
function plan(steps: PlaybookStep[], completion_step_id: string | null = null): PlaybookPlan {
  return {
    title: "Prüfung",
    goal: "Den Stand prüfen",
    steps,
    completion_step_id,
    cancelled: false,
  };
}
async function call(scope: PlaybookScope, tool: string, output: unknown, outcome = "ok") {
  const [row] = await fixture.db
    .insert(conversationToolCalls)
    .values({
      tenant_id: scope.tenant_id,
      conversation_id: scope.conversation_id,
      tool,
      input: {},
      output,
      outcome,
      created_at: timestamp(1000),
    })
    .returning();
  if (!row) throw new Error("missing call");
  return row.id;
}
async function connector() {
  const [row] = await fixture.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: `playbook-${++sequence}`,
      display_name: "Private source title",
      driver: "http",
      created_at: timestamp(),
      updated_at: timestamp(),
    })
    .returning();
  if (!row) throw new Error("missing connector");
  return row;
}

describe("persisted playbook evidence and lifecycle", () => {
  test("stores a delivered assessment without claiming technical completion and audits once", async () => {
    const context = await scope();
    const request = {
      expected_revision: 0,
      plan: plan([
        step({
          kind: "assessment",
          description: "Entscheidungsvorlage",
          result: "Die Vorlage nennt Herkunft, offenen Prüfschritt und zuständige Person.",
        }),
      ]),
    };
    const view = await updatePlaybook(fixture.db, context, request);
    expect(view?.status).toBe("in_progress");
    expect(view?.steps[0]?.status).toBe("assessment_ready");
    expect(view?.completion.status).toBe("open");
    expect((await readPlaybook(fixture.db, context))?.revision).toBe(1);
    await updatePlaybook(fixture.db, context, request);
    const rows = await fixture.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, context.conversation_id)),
      );
    expect(rows.filter((row) => row.reason === "playbook_updated")).toHaveLength(1);
  });

  test("binds an inspected execution as fresh evidence for that exact run", async () => {
    const context = await scope();
    const [workflow] = await fixture.db
      .insert(workflows)
      .values({
        tenant_id: tenantId,
        slug: `inspect-run-${++sequence}`,
        name: "Inspected run",
        lifecycle: "active",
        created_at: timestamp(),
        updated_at: timestamp(),
      })
      .returning();
    if (!workflow) throw new Error("missing workflow");
    const [run] = await fixture.db
      .insert(executions)
      .values({
        tenant_id: tenantId,
        workflow_id: workflow.id,
        status: "failed",
        request_source: "chat",
        execution_mode: "dev",
        started_at: timestamp(100),
        finished_at: timestamp(200),
        created_at: timestamp(100),
      })
      .returning();
    if (!run) throw new Error("missing execution");
    const evidenceId = await call(context, "inspect_execution", {
      inspected: { execution_id: run.id },
      execution: { execution_id: run.id, status: "failed" },
    });
    const view = await updatePlaybook(fixture.db, context, {
      expected_revision: 0,
      plan: plan([
        step({ kind: "resource_observed", resource: { type: "execution", id: run.id } }),
      ]),
    });
    expect(view?.steps[0]?.evidence.map(({ id, label, href }) => ({ id, label, href }))).toEqual([
      { id: evidenceId, label: "Ausführung gelesen", href: `/cockpit/?run=${run.id}` },
    ]);
    expect(view?.steps[0]?.status).toBe("verified");
  });

  test("binds an inspected execution whose stored output was bounded", async () => {
    const context = await scope();
    const [workflow] = await fixture.db
      .insert(workflows)
      .values({
        tenant_id: tenantId,
        slug: `inspect-bounded-${++sequence}`,
        name: "Bounded run",
        lifecycle: "active",
        created_at: timestamp(),
        updated_at: timestamp(),
      })
      .returning();
    if (!workflow) throw new Error("missing workflow");
    const [run] = await fixture.db
      .insert(executions)
      .values({
        tenant_id: tenantId,
        workflow_id: workflow.id,
        status: "failed",
        request_source: "chat",
        execution_mode: "dev",
        started_at: timestamp(100),
        finished_at: timestamp(200),
        created_at: timestamp(100),
      })
      .returning();
    if (!run) throw new Error("missing execution");
    const evidenceId = await call(
      context,
      "inspect_execution",
      boundForPersistence(
        {
          inspected: { execution_id: run.id },
          execution: {
            execution_id: run.id,
            status: "failed",
            steps: [{ id: "request", output: "x".repeat(300_000) }],
          },
        },
        "raw_bounded",
      ),
    );
    const view = await updatePlaybook(fixture.db, context, {
      expected_revision: 0,
      plan: plan([
        step({ kind: "resource_observed", resource: { type: "execution", id: run.id } }),
      ]),
    });
    expect(view?.steps[0]?.evidence.map(({ id }) => id)).toEqual([evidenceId]);
    expect(view?.steps[0]?.status).toBe("verified");
  });

  test("binds an exact successful read, rejects foreign and failed calls, and retries auto-binding idempotently", async () => {
    const context = await scope();
    const other = await scope();
    const resource = await connector();
    const criterion = {
      kind: "resource_observed" as const,
      resource: { type: "connector" as const, id: resource.id },
    };
    const foreignId = await call(other, "get_connector", { connector: { id: resource.id } });
    await expect(
      updatePlaybook(fixture.db, context, {
        expected_revision: 0,
        plan: plan([step(criterion, [foreignId])]),
      }),
    ).rejects.toThrow("playbook_evidence_not_available");
    const failed = await call(
      context,
      "get_connector",
      { connector: { id: resource.id } },
      "error",
    );
    await expect(
      updatePlaybook(fixture.db, context, {
        expected_revision: 0,
        plan: plan([step(criterion, [failed])]),
      }),
    ).rejects.toThrow("playbook_evidence_not_available");
    const unrelated = await call(context, "search_knowledge", { connector: { id: resource.id } });
    await expect(
      updatePlaybook(fixture.db, context, {
        expected_revision: 0,
        plan: plan([step(criterion, [unrelated])]),
      }),
    ).rejects.toThrow("playbook_evidence_not_available");
    const actual = await call(context, "get_connector", { connector: { id: resource.id } });
    const request = { expected_revision: 0, plan: plan([step(criterion)]) };
    const view = await updatePlaybook(fixture.db, context, request);
    expect(view?.steps[0]?.evidence[0]?.id).toBe(actual);
    expect(view?.steps[0]?.status).toBe("verified");
    expect(view?.completion.status).toBe("open");
    expect((await updatePlaybook(fixture.db, context, request))?.revision).toBe(1);
    await fixture.db
      .update(connectors)
      .set({ updated_at: timestamp(2000) })
      .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.id, resource.id)));
    expect((await readPlaybook(fixture.db, context))?.steps[0]?.status).toBe("stale");
    const restricted = { ...context, principal: { ...principal, scopes: ["conversation:read"] } };
    const denied = await readPlaybook(fixture.db, restricted);
    expect(denied?.status).toBe("blocked");
    expect(denied?.steps[0]?.evidence).toEqual([]);
    expect(denied?.steps[0]?.next_action).toBeNull();
    expect(await readPlaybook(fixture.db, { ...context, tenant_id: actorId })).toBeNull();
    const [otherTenant] = await fixture.db
      .insert(tenants)
      .values({ slug: "other-playbook", display_name: "Other tenant" })
      .returning();
    if (!otherTenant) throw new Error("missing tenant");
    const foreignScope = {
      ...context,
      tenant_id: otherTenant.id,
      principal: { ...principal, tenant_id: otherTenant.id },
    };
    expect(await readPlaybook(fixture.db, foreignScope)).toBeNull();
    await expect(
      updatePlaybook(fixture.db, foreignScope, { expected_revision: 0, plan: request.plan }),
    ).rejects.toThrow("conversation_not_found");
  });

  test("requires intake read rights even when knowledge read remains granted", async () => {
    const context = await scope();
    const [item] = await fixture.db
      .insert(intakeItems)
      .values({
        tenant_id: tenantId,
        category: "tests",
        client_request_id: actorId,
        creation_request_digest: "fixture",
        title: "Private clip",
        body: "Untrusted instructions cannot grant authority",
        original_snapshot: {
          origin: "capture",
          title: "Private clip",
          body: "data",
          captured_at: timestamp().toISOString(),
          source_url: "https://example.invalid",
        },
        collected_by_type: "user",
        collected_by_id: actorId,
        created_at: timestamp(),
        updated_at: timestamp(),
      })
      .returning();
    if (!item) throw new Error("missing item");
    const evidenceId = await call(context, "get_intake_item", { item: { id: item.id } });
    await updatePlaybook(fixture.db, context, {
      expected_revision: 0,
      plan: plan([
        step({ kind: "resource_observed", resource: { type: "intake", id: item.id } }, [
          evidenceId,
        ]),
      ]),
    });
    const authorizedView = await readPlaybook(fixture.db, context);
    expect(authorizedView?.steps[0]?.evidence[0]?.href).toBe(
      `/cockpit/intake/${encodeURIComponent(item.id)}`,
    );
    const view = await readPlaybook(fixture.db, {
      ...context,
      principal: { ...principal, scopes: ["conversation:read", "knowledge:read"] },
    });
    expect(view?.status).toBe("blocked");
    expect(view?.steps[0]?.evidence).toEqual([]);
  });

  test("serializes competing revisions and keeps off conversations inert", async () => {
    const context = await scope();
    const base = plan([step({ kind: "assessment", description: "Prüfung", result: null })]);
    const results = await Promise.allSettled([
      updatePlaybook(fixture.db, context, { expected_revision: 0, plan: base }),
      updatePlaybook(fixture.db, context, {
        expected_revision: 0,
        plan: { ...base, title: "Andere Prüfung" },
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason instanceof PlaybookConflictError).toBe(
      true,
    );
    const disabled = await scope("off");
    await expect(
      updatePlaybook(fixture.db, disabled, { expected_revision: 0, plan: base }),
    ).rejects.toThrow("playbooks_disabled");
    expect(await readPlaybook(fixture.db, disabled)).toBeNull();
  });

  test("human confirmation binds its exact question and draft; response deadline does not expire an answered judgment", async () => {
    const context = await scope();
    const question = "Ist das Ziel Den Stand prüfen fachlich bestätigt?";
    const criterion = { kind: "human_confirmation" as const, question };
    await updatePlaybook(fixture.db, context, {
      expected_revision: 0,
      plan: plan([step(criterion)]),
    });
    const decision = await createElicitation(
      {
        tenant_id: tenantId,
        conversation_id: context.conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_confirm",
        summary: question,
        input: { question },
        actor_id: actorId,
        expires_at: timestamp(1000),
      },
      fixture.db,
    );
    await resolveElicitation(
      {
        tenant_id: tenantId,
        id: decision.id,
        output: { confirmed: true },
        decided_by: { id: actorId, kind: "user" },
      },
      fixture.db,
    );
    await fixture.db
      .update(conversationElicitations)
      .set({ decided_at: timestamp() })
      .where(eq(conversationElicitations.id, decision.id));
    const view = await updatePlaybook(fixture.db, context, {
      expected_revision: 1,
      plan: plan([step(criterion, [decision.id])], "check"),
    });
    setTestNow(() => FROZEN_NOW + 2000);
    try {
      expect((await readPlaybook(fixture.db, context))?.steps[0]?.status).toBe("verified");
    } finally {
      setTestNow(() => FROZEN_NOW);
    }
    expect(view?.steps[0]?.assurance).toBe("human");
    expect(view?.steps[0]?.status).toBe("verified");
    await fixture.db
      .update(conversations)
      .set({ draft: { workflow: { name: "Restored draft", steps: [] } } })
      .where(
        and(eq(conversations.tenant_id, tenantId), eq(conversations.id, context.conversation_id)),
      );
    expect((await readPlaybook(fixture.db, context))?.steps[0]?.status).toBe("stale");
    const [stored] = await fixture.db
      .select({ playbook: conversations.playbook })
      .from(conversations)
      .where(
        and(eq(conversations.tenant_id, tenantId), eq(conversations.id, context.conversation_id)),
      );
    const fork = forkPlaybookDocument(stored?.playbook);
    expect(fork?.plan.goal).toBe("Den Stand prüfen");
    expect(fork?.plan.steps[0]?.evidence_ids).toEqual([]);
    expect(fork?.evidence_fingerprints).toEqual({});
    expect(fork?.id).not.toBe(PlaybookDocumentSchema.parse(stored?.playbook).id);
  });

  for (const changedContext of ["draft", "step"] as const) {
    test(`a pending confirmation cannot be rebound after a ${changedContext} change`, async () => {
      const context = await scope();
      const question = "Ist das Ziel Den Stand prüfen fachlich bestätigt?";
      const criterion = { kind: "human_confirmation" as const, question };
      await fixture.db
        .update(conversations)
        .set({ draft: { workflow: { name: "Draft A", steps: [] } } })
        .where(eq(conversations.id, context.conversation_id));
      await updatePlaybook(fixture.db, context, {
        expected_revision: 0,
        plan: plan([step(criterion)]),
      });
      const decision = await createElicitation(
        {
          tenant_id: tenantId,
          conversation_id: context.conversation_id,
          tool_call_id: null,
          tool_name: "ask_user_confirm",
          summary: question,
          input: { question },
          actor_id: actorId,
          expires_at: timestamp(1000),
        },
        fixture.db,
      );
      const expectedRevision = changedContext === "step" ? 2 : 1;
      if (changedContext === "draft") {
        await fixture.db
          .update(conversations)
          .set({ draft: { workflow: { name: "Draft B", steps: [] } } })
          .where(eq(conversations.id, context.conversation_id));
      } else {
        await updatePlaybook(fixture.db, context, {
          expected_revision: 1,
          plan: plan([{ ...step(criterion), id: "renamed" }]),
        });
      }
      await resolveElicitation(
        {
          tenant_id: tenantId,
          id: decision.id,
          output: { confirmed: true },
          decided_by: { id: actorId, kind: "user" },
        },
        fixture.db,
      );
      await fixture.db
        .update(conversationElicitations)
        .set({ decided_at: timestamp() })
        .where(eq(conversationElicitations.id, decision.id));
      const view = await updatePlaybook(fixture.db, context, {
        expected_revision: expectedRevision,
        plan: plan(
          [
            {
              ...step(criterion, [decision.id]),
              id: changedContext === "step" ? "renamed" : "check",
            },
          ],
          changedContext === "step" ? "renamed" : "check",
        ),
      });
      expect(view?.steps[0]?.status).toBe("stale");
      expect(view?.completion.status).toBe("open");
    });
  }

  test("conversation history does not replay stored playbook proposals or assessments", async () => {
    const context = await scope();
    const [message] = await fixture.db
      .insert(conversationMessages)
      .values({
        tenant_id: tenantId,
        conversation_id: context.conversation_id,
        role: "assistant",
        content: { text: "Playbook updated" },
        created_at: timestamp(),
      })
      .returning();
    if (!message) throw new Error("missing message");
    for (const tool of ["inspect_playbook", "update_playbook"]) {
      await fixture.db.insert(conversationToolCalls).values({
        tenant_id: tenantId,
        conversation_id: context.conversation_id,
        parent_message_id: message.id,
        tool,
        input: { assessment: "private-assessment-marker" },
        output: { assessment: "private-assessment-marker" },
        outcome: "ok",
        created_at: timestamp(),
      });
    }
    const detail = await getConversation(tenantId, context.conversation_id, fixture.db, principal);
    expect(detail?.tool_calls.map(({ input, output }) => ({ input, output }))).toEqual([
      { input: { redacted: true }, output: { redacted: true } },
      { input: { redacted: true }, output: { redacted: true } },
    ]);
    expect(
      JSON.stringify(buildMessages(detail?.messages ?? [], detail?.tool_calls ?? [])),
    ).not.toContain("private-assessment-marker");
  });

  test("execution completion rejects partial and held outcomes and requires current version, environment and new execution", async () => {
    const context = await scope();
    const [workflow] = await fixture.db
      .insert(workflows)
      .values({
        tenant_id: tenantId,
        slug: `run-${++sequence}`,
        name: "Run",
        lifecycle: "active",
        created_at: timestamp(),
        updated_at: timestamp(),
      })
      .returning();
    if (!workflow) throw new Error("missing workflow");
    const [version] = await fixture.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenantId,
        workflow_id: workflow.id,
        version: 1,
        dag: {
          steps: [
            { id: "branch", kind: "branch" },
            { id: "request", kind: "request" },
            { id: "untaken", kind: "request" },
          ],
        },
      })
      .returning();
    if (!version) throw new Error("missing version");
    await fixture.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.id, workflow.id)));
    const [run] = await fixture.db
      .insert(executions)
      .values({
        tenant_id: tenantId,
        workflow_id: workflow.id,
        workflow_version_id: version.id,
        status: "succeeded",
        request_source: "api",
        execution_mode: "dev",
        started_at: timestamp(100),
        finished_at: timestamp(200),
        created_at: timestamp(100),
      })
      .returning();
    if (!run) throw new Error("missing run");
    const [runStep] = await fixture.db
      .insert(executionSteps)
      .values({
        tenant_id: tenantId,
        execution_id: run.id,
        step_key: "request",
        kind: "request",
        status: "failed",
        started_at: timestamp(100),
      })
      .returning();
    if (!runStep) throw new Error("missing step");
    await fixture.db.insert(executionSteps).values([
      {
        tenant_id: tenantId,
        execution_id: run.id,
        step_key: "branch",
        kind: "branch",
        status: "succeeded",
        started_at: timestamp(100),
      },
      {
        tenant_id: tenantId,
        execution_id: run.id,
        step_key: "untaken",
        kind: "request",
        status: "skipped",
        started_at: timestamp(100),
      },
    ]);
    const id = await call(context, "get_execution", { execution: { id: run.id } });
    const criterion = {
      kind: "execution_succeeded" as const,
      workflow_id: workflow.id,
      environment: "dev" as const,
      after: timestamp().toISOString(),
    };
    const view = await updatePlaybook(fixture.db, context, {
      expected_revision: 0,
      plan: plan([step(criterion, [id])], "check"),
    });
    expect(view?.completion.status).toBe("open");
    await fixture.db
      .update(executionSteps)
      .set({ status: "succeeded", held: true })
      .where(and(eq(executionSteps.tenant_id, tenantId), eq(executionSteps.id, runStep.id)));
    expect((await readPlaybook(fixture.db, context))?.completion.status).toBe("open");
    await fixture.db
      .update(executionSteps)
      .set({ held: false })
      .where(and(eq(executionSteps.tenant_id, tenantId), eq(executionSteps.id, runStep.id)));
    expect((await readPlaybook(fixture.db, context))?.completion.status).toBe("open");
    const newRead = await call(context, "get_execution", {
      execution: { id: run.id, status: "succeeded" },
      outcome: { kind: "succeeded" },
    });
    await updatePlaybook(fixture.db, context, {
      expected_revision: 1,
      plan: plan([step(criterion, [newRead])], "check"),
    });
    expect((await readPlaybook(fixture.db, context))?.completion.status).toBe("verified");
    await fixture.db
      .update(executions)
      .set({ execution_mode: "prod" })
      .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, run.id)));
    expect((await readPlaybook(fixture.db, context))?.completion.status).toBe("open");
    await fixture.db
      .update(executions)
      .set({ execution_mode: "dev", started_at: timestamp(-100) })
      .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, run.id)));
    await updatePlaybook(fixture.db, context, {
      expected_revision: 2,
      plan: plan(
        [step({ ...criterion, after: timestamp(-1000).toISOString() }, [newRead])],
        "check",
      ),
    });
    expect((await readPlaybook(fixture.db, context))?.completion.status).toBe("open");
    await fixture.db
      .update(workflows)
      .set({ current_version_id: null })
      .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.id, workflow.id)));
    expect((await readPlaybook(fixture.db, context))?.completion.status).toBe("open");
  });

  test("model palette off has no playbook tools; updating guidance creates no workflow snapshot", async () => {
    const context = await scope();
    let draft = createEmptyDraftDocument();
    const ctx: ToolContext = {
      db: fixture.db,
      ...context,
      actor_id: actorId,
      connector_id: null,
      workflow_id: null,
      surface: "web",
      playbook_mode: "off",
      engineClient: new EngineClient({
        db: fixture.db,
        tenant_id: tenantId,
        actor_id: actorId,
        actor_type: "user",
      }),
      getDraft: () => draft,
      setDraft: async (value) => {
        draft = value;
      },
    };
    const signals: TurnSignals = {
      step: 0,
      toolChain: Promise.resolve(),
      pendingChildToolCallIds: [],
      pendingChildElicitationIds: [],
      toolInvocationCount: new Map(),
      toolLastErrorHash: new Map(),
      toolArgsRepeat: new Map(),
      toolValidationFingerprint: new Map(),
      toolErrorCodeRepeat: new Map(),
      totalLoopWarnings: 0,
      consecutiveFailures: 0,
      lastAssistantText: "",
      lastExecutionSuccess: null,
    };
    const off = await wrapTools(ctx, signals, [], fixture.db);
    expect(off.update_playbook).toBeUndefined();
    expect(off.inspect_playbook).toBeUndefined();
    ctx.playbook_mode = "auto";
    const on = await wrapTools(ctx, signals, [], fixture.db);
    const tool = on.update_playbook;
    if (!tool?.execute) throw new Error("missing playbook tool");
    const result = await tool.execute(
      {
        expected_revision: 0,
        plan: plan([
          step({
            kind: "assessment",
            description: "Vorlage erstellen",
            result: "Die tatsächliche Vorlage liegt als gespeicherte Einschätzung vor.",
          }),
        ]),
      },
      { toolCallId: actorId, messages: [], context: {} },
    );
    if (Symbol.asyncIterator in result) throw new Error("unexpected streaming result");
    expect(result.ok).toBe(true);
    const snapshots = await fixture.db
      .select()
      .from(conversationDraftSnapshots)
      .where(
        and(
          eq(conversationDraftSnapshots.tenant_id, tenantId),
          eq(conversationDraftSnapshots.conversation_id, context.conversation_id),
        ),
      );
    expect(snapshots).toHaveLength(0);
  });

  describe("an answered choice advances its playbook step", () => {
    const question = "In welcher Umgebung soll der Ablauf laufen?";
    const nextLabel = "Gewünschte Betriebsumgebung fachlich festlegen";
    const options = [
      { value: "prod", label: "PROD-Betrieb" },
      { value: "dev", label: "DEV-Betrieb" },
    ];
    async function prepared(context: PlaybookScope) {
      await updatePlaybook(fixture.db, context, {
        expected_revision: 0,
        plan: plan([
          {
            ...step({ kind: "assessment", description: "Betriebsumgebung", result: null }),
            id: "target",
            progress: "waiting_for_input",
            next_action: { label: nextLabel, owner: "Betreiber", elicitation_id: null },
          },
        ]),
      });
    }
    async function choice(
      context: PlaybookScope,
      tool_name: "ask_user_choice" | "ask_user_confirm",
      playbook_step_id: string,
    ) {
      const toolCallId = await call(context, tool_name, {}, "pending");
      return createElicitation(
        {
          tenant_id: tenantId,
          conversation_id: context.conversation_id,
          tool_call_id: toolCallId,
          tool_name,
          summary: question,
          input:
            tool_name === "ask_user_choice"
              ? { question, options, playbook_step_id }
              : { question, playbook_step_id },
          actor_id: actorId,
          expires_at: timestamp(60_000),
        },
        fixture.db,
      );
    }
    async function answer(id: string, output: unknown) {
      return resolveElicitation(
        { tenant_id: tenantId, id, output, decided_by: { id: actorId, kind: "user" } },
        fixture.db,
      );
    }

    test("records the selected label, clears the next action, audits and finalizes the call", async () => {
      const context = await scope();
      await prepared(context);
      const decision = await choice(context, "ask_user_choice", "target");
      expect((await answer(decision.id, { value: "prod" })).kind).toBe("resolved");
      const view = await readPlaybook(fixture.db, context);
      expect(view?.revision).toBe(2);
      expect(view?.steps[0]?.next_action).toBeNull();
      expect(view?.steps[0]?.reason).toContain("PROD-Betrieb");
      expect(view?.steps[0]?.status).toBe("in_progress");
      expect(view?.next_action?.label ?? null).not.toBe(nextLabel);
      expect(view?.status).not.toBe("prepared");
      const audits = await fixture.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenantId),
            eq(auditLog.resource_id, context.conversation_id),
            eq(auditLog.reason, "playbook_decision_applied"),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.action).toBe("conversation.updated");
      const [toolCall] = await fixture.db
        .select({ outcome: conversationToolCalls.outcome })
        .from(conversationToolCalls)
        .where(
          and(
            eq(conversationToolCalls.tenant_id, tenantId),
            eq(conversationToolCalls.id, decision.tool_call_id ?? ""),
          ),
        );
      expect(toolCall?.outcome).toBe("ok");
      await expect(
        updatePlaybook(fixture.db, context, {
          expected_revision: 1,
          plan: plan([step({ kind: "assessment", description: "Neu", result: null })]),
        }),
      ).rejects.toBeInstanceOf(PlaybookConflictError);
      const detail = await getConversation(
        tenantId,
        context.conversation_id,
        fixture.db,
        principal,
      );
      const history = detail?.tool_calls.find((item) => item.id === decision.tool_call_id);
      expect(history?.outcome).toBe("ok");
      expect(history?.output).toMatchObject({ status: "resolved", elicitation_id: decision.id });
    });

    test("an unknown step leaves the playbook unchanged", async () => {
      const context = await scope();
      await prepared(context);
      const decision = await choice(context, "ask_user_choice", "missing");
      await answer(decision.id, { value: "prod" });
      const view = await readPlaybook(fixture.db, context);
      expect(view?.revision).toBe(1);
      expect(view?.steps[0]?.next_action?.label).toBe(nextLabel);
    });

    test("a confirmation answer leaves the playbook unchanged", async () => {
      const context = await scope();
      await prepared(context);
      const decision = await choice(context, "ask_user_confirm", "target");
      await answer(decision.id, { confirmed: true });
      expect((await readPlaybook(fixture.db, context))?.revision).toBe(1);
    });

    test("a cancelled choice finalizes the call as denied without touching the playbook", async () => {
      const context = await scope();
      await prepared(context);
      const decision = await choice(context, "ask_user_choice", "target");
      await resolveElicitation(
        {
          tenant_id: tenantId,
          id: decision.id,
          output: null,
          decided_by: { id: actorId, kind: "user" },
          status: "cancelled",
        },
        fixture.db,
      );
      expect((await readPlaybook(fixture.db, context))?.revision).toBe(1);
      const [toolCall] = await fixture.db
        .select({ outcome: conversationToolCalls.outcome })
        .from(conversationToolCalls)
        .where(
          and(
            eq(conversationToolCalls.tenant_id, tenantId),
            eq(conversationToolCalls.id, decision.tool_call_id ?? ""),
          ),
        );
      expect(toolCall?.outcome).toBe("denied");
    });

    test("a choice in another conversation leaves this playbook unchanged", async () => {
      const context = await scope();
      const other = await scope();
      await prepared(context);
      await prepared(other);
      const decision = await choice(other, "ask_user_choice", "target");
      await answer(decision.id, { value: "prod" });
      expect((await readPlaybook(fixture.db, context))?.revision).toBe(1);
      expect((await readPlaybook(fixture.db, other))?.revision).toBe(2);
    });
  });
});

describe("a turn that ends", () => {
  test("leaves no step spinning: work in progress now waits for the user, audited once", async () => {
    const context = await scope();
    await updatePlaybook(fixture.db, context, {
      expected_revision: 0,
      plan: plan([
        {
          ...step({ kind: "resource_observed", resource: { type: "execution", id: actorId } }),
          progress: "in_progress",
        },
      ]),
    });
    expect((await readPlaybook(fixture.db, context))?.steps[0]?.status).toBe("in_progress");
    const settle = () =>
      settlePlaybookAtTurnEnd(fixture.db, {
        tenant_id: tenantId,
        conversation_id: context.conversation_id,
        actor: { actor_type: "user", actor_id: actorId },
        request_source: "ui",
      });
    expect(await settle()).toBe(2);
    const view = await readPlaybook(fixture.db, context);
    expect(view?.steps[0]?.status).toBe("waiting_for_input");
    expect(view?.revision).toBe(2);
    expect(await settle()).toBeNull();
    const audits = await fixture.db
      .select({ reason: auditLog.reason })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, context.conversation_id)),
      );
    expect(audits.filter((row) => row.reason === "playbook_turn_settled")).toHaveLength(1);
  });
});
