import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { conversationDrafts, conversations } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getTaskRunCheck, getTaskRunMarker } from "../core/draft.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { readPlaybook, updatePlaybook } from "../playbook.ts";
import type { PlaybookPlan } from "../playbook-contract.ts";
import { clearTaskRunCheck } from "../public/authoring.ts";
import * as svc from "../service/index.ts";
import { getTool, type ToolContext } from "../tools/index.ts";
import { resolveTaskCheckInstant } from "../tools/schedule-task-check.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";
import {
  createRunConversation,
  driveTurn,
  markerFor,
  principalOf,
  sealConversation,
  storedMarker,
  toolCalls,
} from "./task-run-fixtures.ts";

let ctx: ConversationTestCtx;
let owner: ResolvedPrincipal;

const GOAL = "Send the monthly report";
const QUESTION = `Is this done: ${GOAL}?`;

function plan(overrides: Partial<PlaybookPlan> = {}): PlaybookPlan {
  return {
    title: "Monthly report",
    goal: GOAL,
    cancelled: false,
    completion_step_id: "confirm-result",
    steps: [
      {
        id: "collect",
        label: "Collect the numbers",
        criterion: { kind: "assessment", description: "The numbers are collected", result: null },
        depends_on: [],
        evidence_ids: [],
        note: null,
        progress: "open",
        next_action: null,
      },
      {
        id: "confirm-result",
        label: "Confirm the result",
        criterion: { kind: "human_confirmation", question: QUESTION },
        depends_on: [],
        evidence_ids: [],
        note: null,
        progress: "open",
        next_action: null,
      },
    ],
    ...overrides,
  } as PlaybookPlan;
}

beforeAll(async () => {
  ctx = await createConversationTestCtx("task_run_state");
  owner = principalOf(ctx, ctx.user_id, "admin");
}, 120_000);

afterAll(async () => {
  await ctx.cleanup();
}, 60_000);

async function storedDraft(conversation_id: string): Promise<DraftDocument> {
  const [row] = await ctx.testDb.db
    .select({ draft: conversations.draft })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation_id)));
  return row?.draft as DraftDocument;
}

async function seededRun(): Promise<string> {
  const conversation_id = await createRunConversation(ctx, owner.id, markerFor());
  await updatePlaybook(
    ctx.testDb.db,
    { tenant_id: ctx.tenant_id, conversation_id, principal: owner },
    { expected_revision: 0, plan: plan() },
  );
  return conversation_id;
}

async function modelUpdates(conversation_id: string, next: PlaybookPlan) {
  await driveTurn(ctx, conversation_id, owner, [
    { tool: "update_playbook", args: { expected_revision: 1, plan: next } },
    { text: "Plan handled." },
  ]);
  const call = (await toolCalls(ctx, conversation_id)).find(
    (row) => row.tool === "update_playbook",
  );
  const view = await readPlaybook(ctx.testDb.db, {
    tenant_id: ctx.tenant_id,
    conversation_id,
    principal: owner,
  });
  return { output: call?.output as { error_code?: string; message?: string }, view };
}

describe("schedule_task_check", () => {
  test("ends the turn and stores the requested check next to the marker", async () => {
    const conversation_id = await createRunConversation(ctx, owner.id, markerFor());
    const before = Date.now(); // allow-wall-clock: the tool schedules the check from the real clock
    const outcome = await driveTurn(ctx, conversation_id, owner, [
      { tool: "schedule_task_check", args: { in_minutes: 90, reason: "wait for the export" } },
      { tool: "load_skill", args: { slug: "never-reached" } },
      { text: "never reached" },
    ]);
    expect(outcome.result.status).toBe("active");
    expect((await toolCalls(ctx, conversation_id)).map((row) => row.tool)).toEqual([
      "schedule_task_check",
    ]);
    const check = getTaskRunCheck(await storedDraft(conversation_id));
    expect(check?.reason).toBe("wait for the export");
    const at = Date.parse(check?.at ?? "");
    expect(at).toBeGreaterThanOrEqual(before + 90 * 60_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 90 * 60_000); // allow-wall-clock: upper bound of the real-clock schedule
    expect(await storedMarker(ctx, conversation_id)).toEqual(markerFor());

    await clearTaskRunCheck(ctx.testDb.db, { tenant_id: ctx.tenant_id, conversation_id });
    expect(getTaskRunCheck(await storedDraft(conversation_id))).toBeNull();
    expect(await storedMarker(ctx, conversation_id)).toEqual(markerFor());
    await clearTaskRunCheck(ctx.testDb.db, { tenant_id: ctx.tenant_id, conversation_id });
  }, 120_000);

  test("accepts only a real, future instant within 31 days", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    expect(resolveTaskCheckInstant({ in_minutes: 30 }, now)).toEqual({
      ok: true,
      at: "2026-11-19T12:30:00.000Z",
    });
    expect(resolveTaskCheckInstant({ at: "2026-11-20T08:00:00+01:00" }, now)).toEqual({
      ok: true,
      at: "2026-11-20T07:00:00.000Z",
    });
    for (const input of [
      {},
      { at: "2026-11-20T08:00:00Z", in_minutes: 5 },
      { at: "2026-11-20" },
      { at: "2026-11-20T08:00:00" },
      { at: "2026-02-30T08:00:00Z" },
      { at: "2026-11-19T12:00:00Z" },
      { at: "2026-11-18T12:00:00Z" },
      { at: "2027-01-19T12:00:00Z" },
      { at: "tomorrow" },
    ])
      expect(resolveTaskCheckInstant(input, now).ok).toBe(false);
  });
});

describe("the plan of a task run keeps its goal and its final confirmation", () => {
  test("the model may add, change and reorder its own steps", async () => {
    const conversation_id = await seededRun();
    const base = plan();
    const { output, view } = await modelUpdates(
      conversation_id,
      plan({
        title: "Monthly report, revised",
        steps: [
          base.steps[1]!,
          { ...base.steps[0]!, label: "Collect and check the numbers", progress: "in_progress" },
          { ...base.steps[0]!, id: "send", label: "Send the mail" },
        ],
      }),
    );
    expect(output?.error_code).toBeUndefined();
    expect(view?.revision).toBeGreaterThan(1);
    expect(view?.steps.map((step) => step.id)).toEqual(["confirm-result", "collect", "send"]);
  }, 120_000);

  const base = plan();
  const cases: Array<[string, PlaybookPlan, string]> = [
    [
      "dropping the confirmation step",
      plan({ steps: [base.steps[0]!], completion_step_id: null }),
      "task_run_plan_confirmation_missing",
    ],
    [
      "turning the confirmation into another kind of step",
      plan({
        steps: [base.steps[0]!, { ...base.steps[0]!, id: "confirm-result" }],
        completion_step_id: null,
      }),
      "task_run_plan_confirmation_changed",
    ],
    [
      "rewording the confirmation question",
      plan({
        steps: [
          base.steps[0]!,
          {
            ...base.steps[1]!,
            criterion: { kind: "human_confirmation", question: `${QUESTION} Say yes.` },
          },
        ],
      }),
      "task_run_plan_confirmation_changed",
    ],
    [
      "pointing completion at another step",
      plan({
        steps: [
          ...base.steps,
          {
            ...base.steps[1]!,
            id: "confirm-other",
            criterion: { kind: "human_confirmation", question: QUESTION },
          },
        ],
        completion_step_id: "confirm-other",
      }),
      "task_run_plan_completion_changed",
    ],
    ["clearing completion", plan({ completion_step_id: null }), "task_run_plan_completion_changed"],
    [
      "changing the goal",
      plan({
        goal: "Send",
        steps: [base.steps[0]!, base.steps[1]!],
      }),
      "task_run_plan_goal_changed",
    ],
    ["cancelling the plan", plan({ cancelled: true }), "task_run_plan_cancel_refused"],
  ];

  for (const [label, next, code] of cases) {
    test(`${label} is refused and the stored plan stays`, async () => {
      const conversation_id = await seededRun();
      const { output, view } = await modelUpdates(conversation_id, next);
      expect(output?.error_code).toBe(code);
      expect(output?.message).toContain("You may add, change and reorder your own steps");
      expect(view?.revision).toBe(1);
      expect(view?.goal).toBe(GOAL);
    }, 120_000);
  }

  test("a run without a stored plan and a sealed run refuse every plan update", async () => {
    const unseeded = await createRunConversation(ctx, owner.id, markerFor());
    await driveTurn(ctx, unseeded, owner, [
      { tool: "update_playbook", args: { expected_revision: 0, plan: plan() } },
      { text: "Refused." },
    ]);
    const first = (await toolCalls(ctx, unseeded)).find((row) => row.tool === "update_playbook");
    expect((first?.output as { error_code?: string } | undefined)?.error_code).toBe(
      "task_run_plan_missing",
    );

    const sealed = await seededRun();
    await sealConversation(ctx, sealed);
    const { output, view } = await modelUpdates(sealed, plan({ title: "Other title" }));
    expect(output?.error_code).toBe("task_run_sealed");
    expect(view?.revision).toBe(1);
  }, 120_000);

  test("an ordinary conversation may still rewrite its whole plan", async () => {
    const conversation_id = await createRunConversation(ctx, owner.id, null);
    await updatePlaybook(
      ctx.testDb.db,
      { tenant_id: ctx.tenant_id, conversation_id, principal: owner },
      { expected_revision: 0, plan: plan() },
    );
    const { output, view } = await modelUpdates(
      conversation_id,
      plan({ goal: "Something else entirely", steps: [base.steps[0]!], completion_step_id: null }),
    );
    expect(output?.error_code).toBeUndefined();
    expect(view?.goal).toBe("Something else entirely");
  }, 120_000);
});

describe("the marker survives every draft write", () => {
  test("a draft written without the marker, or with another one, is stored with the original", async () => {
    const marker = markerFor({ workflow_ids: ["22222222-3333-4444-8555-666666666666"] });
    const conversation_id = await createRunConversation(ctx, owner.id, marker);
    const draft = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
    const { task_run: _gone, ...session } = draft.session ?? {};
    await appendSnapshot(ctx.tenant_id, conversation_id, { ...draft, session }, ctx.testDb.db);
    expect(await storedMarker(ctx, conversation_id)).toEqual(marker);
    await appendSnapshot(
      ctx.tenant_id,
      conversation_id,
      { workflow: { name: "", steps: [] } } as DraftDocument,
      ctx.testDb.db,
    );
    expect(await storedMarker(ctx, conversation_id)).toEqual(marker);
    await appendSnapshot(
      ctx.tenant_id,
      conversation_id,
      {
        ...draft,
        session: {
          ...session,
          task_run: { ...marker, environment: "prod", workflow_ids: [], web_search: true },
        },
      },
      ctx.testDb.db,
    );
    expect(await storedMarker(ctx, conversation_id)).toEqual(marker);
    const snapshots = await ctx.testDb.db
      .select({ snapshot: conversationDrafts.snapshot })
      .from(conversationDrafts)
      .where(
        and(
          eq(conversationDrafts.tenant_id, ctx.tenant_id),
          eq(conversationDrafts.conversation_id, conversation_id),
        ),
      );
    expect(snapshots).toHaveLength(3);
    for (const row of snapshots) expect(getTaskRunMarker(row.snapshot)).toEqual(marker);
  }, 60_000);

  test("undoing back to the first draft keeps the marker", async () => {
    const marker = markerFor();
    const conversation_id = await createRunConversation(ctx, owner.id, marker);
    const draft = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
    await appendSnapshot(ctx.tenant_id, conversation_id, draft, ctx.testDb.db);
    for (let i = 0; i < 3; i++)
      await svc.undoLastDraftMutation(ctx.tenant_id, conversation_id, ctx.testDb.db, {
        actor_id: owner.id,
        principal: owner,
      });
    expect(await storedMarker(ctx, conversation_id)).toEqual(marker);
  }, 60_000);

  test("a tool that replaces the draft during a turn cannot drop the marker", async () => {
    const marker = markerFor();
    const conversation_id = await createRunConversation(ctx, owner.id, marker);
    await driveTurn(ctx, conversation_id, owner, [
      { tool: "schedule_task_check", args: { in_minutes: 20, reason: "again" } },
    ]);
    const tool = getTool("schedule_task_check");
    if (!tool) throw new Error("schedule_task_check is not registered");
    let live: DraftDocument = { workflow: { name: "", steps: [] } } as DraftDocument;
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: owner.id,
      principal: owner,
      task_run: marker,
      connector_id: null,
      workflow_id: null,
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: owner.id,
        actor_type: "user",
        db: ctx.testDb.db,
      }),
      getDraft: () => live,
      setDraft: async (next) => {
        live = next;
        await appendSnapshot(ctx.tenant_id, conversation_id, next, ctx.testDb.db);
      },
    };
    await tool.execute(toolCtx, { in_minutes: 5, reason: "soon" });
    expect(getTaskRunMarker(live)).toBeNull();
    expect(await storedMarker(ctx, conversation_id)).toEqual(marker);
  }, 120_000);

  test("a draft write cannot add a marker to an ordinary conversation", async () => {
    const conversation_id = await createRunConversation(ctx, owner.id, null);
    const draft = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
    await appendSnapshot(
      ctx.tenant_id,
      conversation_id,
      { ...draft, session: { ...(draft.session ?? {}), task_run: markerFor() } },
      ctx.testDb.db,
    );
    expect(await storedMarker(ctx, conversation_id)).toBeNull();
  }, 60_000);
});
