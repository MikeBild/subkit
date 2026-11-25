import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  conversationDraftSnapshots,
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  executionSteps,
  executions,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { EngineClient } from "../engine-client/index.ts";
import { FROZEN_NOW, setTestNow } from "../test-helpers/determinism/clock.ts";
import { openedElicitation } from "../test-helpers/elicitations.ts";
import { createEmptyDraftDocument } from "./authoring-state/index.ts";
import { createElicitation, resolveElicitation } from "./elicitations.ts";
import { buildMessages } from "./parts.ts";
import { forkPlaybookDocument, readPlaybook, updatePlaybook } from "./playbook.ts";
import { PlaybookDocumentSchema } from "./playbook-contract.ts";
import {
  actorId,
  call,
  fixture,
  nextSequence,
  plan,
  principal,
  scope,
  step,
  tenantId,
  timestamp,
  usePlaybookSetup,
} from "./playbook-fixtures.ts";
import { getConversation } from "./service/get.ts";
import type { ToolContext } from "./tools/index.ts";
import type { TurnSignals } from "./tools/sdk-wrap/state.ts";
import { wrapTools } from "./tools/sdk-wrap.ts";

usePlaybookSetup();

describe("persisted playbook evidence and lifecycle", () => {
  test("human confirmation binds its exact question and draft; response deadline does not expire an answered judgment", async () => {
    const context = await scope();
    const question = "Ist das Ziel Den Stand prüfen fachlich bestätigt?";
    const criterion = { kind: "human_confirmation" as const, question };
    await updatePlaybook(fixture.db, context, {
      expected_revision: 0,
      plan: plan([step(criterion)]),
    });
    const decision = openedElicitation(
      await createElicitation(
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
      ),
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
      const decision = openedElicitation(
        await createElicitation(
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
        ),
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
        slug: `run-${nextSequence()}`,
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
});
