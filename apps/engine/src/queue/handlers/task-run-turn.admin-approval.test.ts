import { describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { completeApprovalBackedElicitation } from "../../conversations/public/authoring.ts";
import {
  inTaskRunApprovalTrace,
  mayDecideTaskRunApproval,
  taskRunApprovalRefusal,
  taskRunApprovalTrace,
} from "../../conversations/public/lifecycle.ts";
import { assertTaskRunApprovalDecider } from "../../conversations/service/task-run-access.ts";
import {
  auditLog,
  executions,
  toolApprovals,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { withContext } from "../../logging/context.ts";
import { grantApproval } from "../../tools/approval.ts";
import { enqueueApprovalElicitationResume } from "../approval-resume.ts";
import { CONVERSATION_RUN_TURN_QUEUE, type ConversationRunTurnJob } from "../queues.ts";
import { registerConversationRunTurnHandler } from "./conversation-run-turn.ts";
import { enqueueTaskRunTurn } from "./task-run-turn.ts";
import {
  answerAsPerson,
  boss,
  clearQueue,
  db,
  jobOf,
  ownedTask,
  pendingElicitation,
  person,
  runRow,
  type StartedRun,
  script,
  startedRun,
  taskInput,
  useTaskRunQueue,
  type Workspace,
  workQueuedTurn,
  workspace,
} from "./task-run-turn-fixtures.ts";

useTaskRunQueue("task_run_turn_admin_approval");

let sequence = 0;

interface HeldRun {
  w: Workspace;
  run: StartedRun;
  workflow_id: string;
  approval_id: string;
  elicitation_id: string;
}

async function heldRun(): Promise<HeldRun> {
  const w = await workspace();
  const slug = `send-digest-${++sequence}`;
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
        steps: [
          {
            id: "send",
            kind: "request",
            method: "POST",
            url: "http://127.0.0.1:9/messages",
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
  script(run.conversation_id, [{ tool: `wf_${slug}`, args: {} }]);
  expect(await workQueuedTurn()).toBe(true);
  const pending = await pendingElicitation(w, run.conversation_id);
  const approval_id = (pending.input as { commit_intent?: { payload?: { approval_id?: string } } })
    .commit_intent?.payload?.approval_id;
  if (!approval_id) throw new Error("expected held writes that wait for an approval");
  expect((await runRow(w, run.id)).waiting_reason).toBe("approval");
  script(run.conversation_id, [{ text: "The digest went out." }]);
  return { w, run, workflow_id: workflow.id, approval_id, elicitation_id: pending.id };
}

async function approvalRow(held: HeldRun) {
  const [row] = await db
    .select()
    .from(toolApprovals)
    .where(
      and(eq(toolApprovals.tenant_id, held.w.tenant_id), eq(toolApprovals.id, held.approval_id)),
    );
  if (!row) throw new Error("missing approval");
  return row;
}

async function releasedExecutions(held: HeldRun) {
  return await db
    .select({
      caller: executions.caller_context,
      authorization: executions.authorization_context,
      audit_trace_id: executions.audit_trace_id,
      workflow_id: executions.workflow_id,
    })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, held.w.tenant_id),
        eq(executions.tool_approval_id, held.approval_id),
      ),
    );
}

async function approvalAudit(held: HeldRun) {
  return await db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      result: auditLog.result,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, held.w.tenant_id), eq(auditLog.resource_id, held.approval_id)),
    )
    .orderBy(asc(auditLog.ts), asc(auditLog.id));
}

function expectRunsAsTheRun(
  released: Awaited<ReturnType<typeof releasedExecutions>>,
  held: HeldRun,
): void {
  expect(released.length).toBeGreaterThan(0);
  for (const execution of released) {
    expect(execution.workflow_id).toBe(held.workflow_id);
    expect(execution.caller).toMatchObject({
      principalId: held.w.owner.id,
      principalKind: "user",
      provider: "task",
    });
    expect(execution.authorization).toMatchObject({
      source: { kind: "task_run", task_id: held.run.task_id, task_run_id: held.run.id },
      allowed_workflows: [held.workflow_id],
      allowed_connectors: [],
    });
  }
  expect(released.at(-1)?.audit_trace_id).toBe(held.run.trace_id);
}

function decision(
  entries: Awaited<ReturnType<typeof approvalAudit>>,
  action: string,
): (typeof entries)[number] {
  const entry = entries.find((candidate) => candidate.action === action);
  if (!entry) throw new Error(`no ${action} entry: ${entries.map((e) => e.action).join(", ")}`);
  return entry;
}

describe("an admin decides the held changes of someone else's run", () => {
  test("approving in the conversation releases them with the rights of the run and names the admin", async () => {
    const held = await heldRun();
    const { w, run } = held;
    await answerAsPerson(w, run.conversation_id, w.admin, { confirmed: true });

    const approval = await approvalRow(held);
    expect(approval.granted_by_user_id).toBe(w.admin.id);
    expect(approval.consumed_at).not.toBeNull();
    expect(approval.principal_id).toBe(w.owner.id);
    expectRunsAsTheRun(await releasedExecutions(held), held);

    const entries = await approvalAudit(held);
    expect(decision(entries, "approval.granted")).toMatchObject({
      actor_type: "user",
      actor_id: w.admin.id,
      result: "success",
      metadata: { audit_trace_id: run.trace_id, decided_by_user_id: w.admin.id },
    });
    expect(decision(entries, "approval.approved")).toMatchObject({
      actor_type: "user",
      actor_id: w.owner.id,
      metadata: { audit_trace_id: run.trace_id },
    });
  }, 240_000);

  test("declining in the conversation ends the held changes and names the admin", async () => {
    const held = await heldRun();
    const { w, run } = held;
    const before = (await releasedExecutions(held)).length;
    await answerAsPerson(w, run.conversation_id, w.admin, { confirmed: false });

    const approval = await approvalRow(held);
    expect(approval.declined_at).not.toBeNull();
    expect(approval.granted_at).toBeNull();
    expect(approval.consumed_at).toBeNull();
    expect((await releasedExecutions(held)).length).toBe(before);
    expect(decision(await approvalAudit(held), "approval.declined")).toMatchObject({
      actor_type: "user",
      actor_id: w.admin.id,
      result: "success",
      metadata: { audit_trace_id: run.trace_id, decided_by_user_id: w.admin.id },
    });
  }, 240_000);

  test("a member who is neither the owner nor an admin is refused on every path", async () => {
    const held = await heldRun();
    const { w, run } = held;
    const member = await person(w.tenant_id, "member");
    const pending = await pendingElicitation(w, run.conversation_id);
    const asked = { tenant_id: w.tenant_id, approval_id: held.approval_id };

    await expect(
      answerAsPerson(w, run.conversation_id, member, { confirmed: true }),
    ).rejects.toMatchObject({ status: 403, code: "task_run_write_forbidden" });
    await expect(
      answerAsPerson(w, run.conversation_id, member, { confirmed: false }),
    ).rejects.toMatchObject({ status: 403, code: "task_run_write_forbidden" });
    const writer = { tenant_id: w.tenant_id, conversation_id: run.conversation_id };
    for (const stranger of [
      { ...writer, actor_id: member.id, principal: member },
      { ...writer, actor_id: member.id },
      { ...writer, actor_id: null },
      { ...writer, actor_id: w.admin.id, principal: { ...w.admin, tenant_id: member.id } },
    ])
      await expect(assertTaskRunApprovalDecider(db, stranger, pending.input)).rejects.toMatchObject(
        { status: 403, code: "task_run_approval_owner_only" },
      );
    expect(await taskRunApprovalRefusal(db, { ...asked, user_id: member.id })).toBe(
      "owner_or_admin",
    );
    expect(await taskRunApprovalRefusal(db, { ...asked, user_id: null })).toBe("owner_or_admin");
    expect(await mayDecideTaskRunApproval(db, { ...asked, user_id: member.id })).toBe(false);
    expect(await mayDecideTaskRunApproval(db, { ...asked, user_id: w.owner.id })).toBe(true);
    expect(await mayDecideTaskRunApproval(db, { ...asked, user_id: w.admin.id })).toBe(true);

    const approval = await approvalRow(held);
    expect(approval.granted_at).toBeNull();
    expect(approval.declined_at).toBeNull();
    expect((await pendingElicitation(w, run.conversation_id)).id).toBe(held.elicitation_id);
    expect((await runRow(w, run.id)).state).toBe("waiting");
  }, 240_000);

  test("an admin is refused when the rights of the run are gone, and nothing changes", async () => {
    const held = await heldRun();
    const { w, run } = held;
    const stored = await approvalRow(held);
    await db
      .update(toolApprovals)
      .set({ caller_context: null, authorization_context: null })
      .where(and(eq(toolApprovals.tenant_id, w.tenant_id), eq(toolApprovals.id, held.approval_id)));
    await expect(
      answerAsPerson(w, run.conversation_id, w.admin, { confirmed: true }),
    ).rejects.toMatchObject({ status: 409, code: "task_run_approval_unavailable" });
    await db
      .update(toolApprovals)
      .set({
        caller_context: stored.caller_context
          ? { ...stored.caller_context, principalId: w.admin.id }
          : null,
        authorization_context: stored.authorization_context,
      })
      .where(and(eq(toolApprovals.tenant_id, w.tenant_id), eq(toolApprovals.id, held.approval_id)));
    await expect(
      answerAsPerson(w, run.conversation_id, w.admin, { confirmed: true }),
    ).rejects.toMatchObject({ status: 409, code: "task_run_approval_unavailable" });

    const approval = await approvalRow(held);
    expect(approval.granted_at).toBeNull();
    expect(approval.consumed_at).toBeNull();
    expect((await pendingElicitation(w, run.conversation_id)).id).toBe(held.elicitation_id);
  }, 240_000);

  test("approving in the approval portal resumes the run with its own rights and names the admin", async () => {
    const held = await heldRun();
    const { w, run } = held;
    const asked = { tenant_id: w.tenant_id, approval_id: held.approval_id };
    expect(await taskRunApprovalRefusal(db, { ...asked, user_id: w.admin.id })).toBeNull();
    expect(await taskRunApprovalTrace(db, asked)).toBe(run.trace_id);

    let work: ((jobs: Job<ConversationRunTurnJob>[]) => Promise<void>) | undefined;
    const capturing = new Proxy(boss, {
      get: (target, key) =>
        key === "work"
          ? async (_queue: string, _options: unknown, handler: typeof work) => {
              work = handler;
              return "captured-worker";
            }
          : Reflect.get(target, key, target),
    }) as PgBoss;
    await registerConversationRunTurnHandler({ boss: capturing, db });

    await withContext(
      { audit_trace_id: "f".repeat(32), audit_access_type: "browser_session" },
      () =>
        inTaskRunApprovalTrace(db, asked, async () => {
          const granted = await grantApproval({
            db,
            ...asked,
            granted_by_user_id: w.admin.id,
            via: "portal",
          });
          expect(granted.ok).toBe(true);
          const completion = await completeApprovalBackedElicitation(
            {
              ...asked,
              decision: "approve",
              approver_user_id: w.admin.id,
              resume: (resume) => enqueueApprovalElicitationResume(resume, db, boss),
            },
            db,
          );
          expect(completion).toEqual({ matched: 1, resumed: 1 });
        }),
    );

    const [job] = await boss.fetch<ConversationRunTurnJob>(CONVERSATION_RUN_TURN_QUEUE);
    if (!job || !work) throw new Error("the approved continuation was not queued");
    const runAs = job.data.principal as ResolvedPrincipal;
    expect(runAs).toMatchObject({
      id: w.owner.id,
      kind: "user",
      provider: "task",
      roles: ["member"],
      allowed_workflows: [held.workflow_id],
      allowed_connectors: [],
      auth_source: { kind: "task_run", task_run_id: run.id },
    });
    expect(job.data).toMatchObject({
      actor_id: w.owner.id,
      approver_user_id: w.admin.id,
      answer_channel: "portal",
    });
    await work([job]);
    await boss.complete(CONVERSATION_RUN_TURN_QUEUE, job.id);

    const approval = await approvalRow(held);
    expect(approval.granted_by_user_id).toBe(w.admin.id);
    expect(approval.granted_via).toBe("portal");
    expect(approval.consumed_at).not.toBeNull();
    expectRunsAsTheRun(await releasedExecutions(held), held);
    expect(decision(await approvalAudit(held), "approval.granted")).toMatchObject({
      actor_type: "user",
      actor_id: w.admin.id,
      metadata: { audit_trace_id: run.trace_id, decided_via: "portal" },
    });
  }, 240_000);
});
