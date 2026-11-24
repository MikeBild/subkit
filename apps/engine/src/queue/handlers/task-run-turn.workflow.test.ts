import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTool } from "../../conversations/tools/index.ts";
import { taskRunToolRefusal } from "../../conversations/tools/sdk-wrap/task-run-guard.ts";
import {
  conversationElicitations,
  conversationToolCalls,
  executions,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { enqueueTaskRunTurn } from "./task-run-turn.ts";
import {
  answerAsPerson,
  clearQueue,
  db,
  jobOf,
  ownedTask,
  pendingElicitation,
  person,
  runRow,
  script,
  startedRun,
  taskInput,
  useTaskRunQueue,
  type Workspace,
  workQueuedTurn,
  workspace,
} from "./task-run-turn-fixtures.ts";

const nextUuid = createDeterministicUuidFactory(0x7a5c08);

useTaskRunQueue("task_run_turn_workflow");

let sequence = 0;

async function writingWorkflow(
  w: Workspace,
  options: { url?: string; input_schema?: Record<string, unknown> } = {},
): Promise<{ id: string; slug: string }> {
  const slug = `send-report-${++sequence}`;
  const [workflow] = await db
    .insert(workflows)
    .values({ tenant_id: w.tenant_id, slug, name: slug, lifecycle: "active", is_tool: false })
    .returning();
  if (!workflow) throw new Error("missing workflow");
  const [version] = await db
    .insert(workflowVersions)
    .values({
      tenant_id: w.tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: slug,
        slug,
        ...(options.input_schema ? { input_schema: options.input_schema } : {}),
        steps: [
          {
            id: "send",
            kind: "request",
            method: "POST",
            url: options.url ?? "http://127.0.0.1:9/messages",
            body: { recipient: "reviewed@example.test" },
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("missing version");
  await db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, w.tenant_id), eq(workflows.id, workflow.id)));
  return { id: workflow.id, slug };
}

function palette(): string[] {
  const palettes = getMockProvider().toolPalettes;
  return (palettes[palettes.length - 1] ?? []).map((tool) => tool.name);
}

describe("bound workflows in a task run", () => {
  test("every bound workflow has its own tool and a change asks the person before it is made", async () => {
    const w = await workspace();
    const bound = [];
    for (let index = 0; index < 20; index++) bound.push(await writingWorkflow(w));
    const task = await ownedTask(
      w,
      taskInput({
        bindings: {
          workflow_ids: bound.map((workflow) => workflow.id),
          connector_ids: [],
          skill_slugs: [],
          web_search: false,
        },
      }),
    );
    const run = await startedRun(w, task);
    await clearQueue();
    await enqueueTaskRunTurn(db, jobOf(w, run));
    const first = bound[0] as { id: string; slug: string };
    script(run.conversation_id, [
      { tool: `wf_${first.slug}`, args: {} },
      { text: "never reached" },
    ]);
    expect(await workQueuedTurn()).toBe(true);
    const offered = palette();
    for (const workflow of bound) expect(offered).toContain(`wf_${workflow.slug}`);
    expect(offered).not.toContain("run_workflow");

    const pending = await db
      .select({ input: conversationElicitations.input, status: conversationElicitations.status })
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, w.tenant_id),
          eq(conversationElicitations.conversation_id, run.conversation_id),
        ),
      );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
    expect(pending[0]?.input).toMatchObject({
      commit_intent: { kind: "commit_held_workflow_writes" },
    });
    expect(await runRow(w, run.id)).toMatchObject({
      state: "waiting",
      waiting_reason: "approval",
      turns_used: 1,
    });
    const calls = await db
      .select({
        id: conversationToolCalls.id,
        tool: conversationToolCalls.tool,
        outcome: conversationToolCalls.outcome,
      })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, w.tenant_id),
          eq(conversationToolCalls.conversation_id, run.conversation_id),
        ),
      );
    const ran = calls.find((call) => call.tool === `wf_${first.slug}`);
    expect(ran?.outcome).toBe("pending");
    expect((await runRow(w, run.id)).progress_marks).toEqual([]);

    await expect(
      answerAsPerson(w, run.conversation_id, await person(w.tenant_id, "member"), {
        confirmed: true,
      }),
    ).rejects.toMatchObject({ status: 403, code: "task_run_write_forbidden" });
    const [still] = await db
      .select({ status: conversationElicitations.status })
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, w.tenant_id),
          eq(conversationElicitations.conversation_id, run.conversation_id),
        ),
      );
    expect(still?.status).toBe("pending");
    expect((await runRow(w, run.id)).state).toBe("waiting");
  }, 240_000);

  test("the generic run tool is refused with the name of the workflow's own tool", async () => {
    const w = await workspace();
    const workflow = await writingWorkflow(w);
    const marker = {
      task_id: nextUuid(),
      task_run_id: nextUuid(),
      environment: "dev" as const,
      workflow_ids: [workflow.id],
      connector_ids: [],
      web_search: false,
    };
    const ctx = { db, tenant_id: w.tenant_id } as never;
    const tool = getTool("run_workflow");
    if (!tool) throw new Error("run_workflow is not registered");
    const named = await taskRunToolRefusal(tool, marker, ctx, { workflow: workflow.slug });
    expect(named).toMatchObject({ ok: false, error_code: "task_run_use_workflow_tool" });
    expect(JSON.stringify(named)).toContain(`wf_${workflow.slug}`);
    const unnamed = await taskRunToolRefusal(tool, marker, ctx, {});
    expect(unnamed).toMatchObject({ error_code: "task_run_use_workflow_tool" });
    const foreign = await taskRunToolRefusal(tool, marker, ctx, { workflow: "not-part-of-it" });
    expect(foreign).toMatchObject({ error_code: "task_run_workflow_not_bound" });
  }, 120_000);

  test("approving held writes of a workflow without input runs them once (#539)", async () => {
    const received: string[] = [];
    const receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        received.push(request.method);
        return Response.json({ ok: true });
      },
    });
    try {
      const w = await workspace();
      const workflow = await writingWorkflow(w, {
        url: `http://127.0.0.1:${receiver.port}/messages`,
        input_schema: { type: "object" },
      });
      const task = await ownedTask(
        w,
        taskInput({
          bindings: {
            workflow_ids: [workflow.id],
            connector_ids: [],
            skill_slugs: [],
            web_search: false,
          },
        }),
      );
      const run = await startedRun(w, task);
      await clearQueue();
      await enqueueTaskRunTurn(db, jobOf(w, run));
      script(run.conversation_id, [{ tool: `wf_${workflow.slug}`, args: {} }]);
      expect(await workQueuedTurn()).toBe(true);
      const pending = await pendingElicitation(w, run.conversation_id);
      const approval_id = (
        pending.input as { commit_intent?: { payload?: { approval_id?: string } } }
      ).commit_intent?.payload?.approval_id;
      if (!approval_id) throw new Error("expected held writes that wait for an approval");
      expect(received).toEqual([]);
      script(run.conversation_id, [{ text: "The report went out." }]);

      await answerAsPerson(w, run.conversation_id, w.owner, { confirmed: true });

      const released = await db
        .select({ status: executions.status })
        .from(executions)
        .where(
          and(eq(executions.tenant_id, w.tenant_id), eq(executions.tool_approval_id, approval_id)),
        );
      expect(released).toEqual([{ status: "succeeded" }]);
      expect(received).toEqual(["POST"]);
    } finally {
      receiver.stop(true);
    }
  }, 240_000);
});
