// Declined-intent guard — a "no" stays a "no" within one conversation.
//
// Three seams:
//   1. confirm.ts short-circuits an identical re-proposal (pure, fake ctx).
//   2. normalizeState revives `last_denied_intent` across resume.
//   3. recordDeniedIntentIfDeclined stamps the fingerprint on decline and
//      the round-trip through the draft store survives (per-file DB).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations } from "../db/schema/index.ts";
import { getMockProvider } from "../llm/mock-provider.ts";
import { createEmptyState, normalizeState } from "./authoring-state/normalize.ts";
import {
  createEmptyDraftDocument,
  withLatestPreview,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "./authoring-state.ts";
import { recordDeniedIntentIfDeclined } from "./declined-intent.ts";
import { appendSnapshot, loadDraft } from "./draft.ts";
import { authoringIntentFingerprint } from "./intent-fingerprint.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  respondElicitationForTest,
} from "./tests/setup.ts";
import { askUserConfirmTool } from "./tools/ask-user/confirm.ts";
import type { ToolContext } from "./tools/index.ts";
import type { DraftDocument, TurnEvent } from "./types.ts";

const WORKFLOW = { name: "wf", steps: [{ id: "s1", kind: "request" }] };

function draftWithDenial(fingerprint: string | null): DraftDocument {
  const state = createEmptyState("workflow");
  if (fingerprint)
    state.last_denied_intent = { fingerprint, timestamp: "2026-07-16T00:00:00.000Z" };
  return { workflow: WORKFLOW, state } as unknown as DraftDocument;
}

function confirmCtx(
  draft: DraftDocument,
  mode: "ask" | "auto" = "ask",
): { ctx: ToolContext; current: () => DraftDocument } {
  let live = draft;
  const ctx = {
    getDraft: () => live,
    setDraft: async (next: DraftDocument) => {
      live = next;
    },
    permission_mode: mode,
  } as unknown as ToolContext;
  return { ctx, current: () => live };
}

const CONFIRM_ARGS = {
  question: "Save this workflow?",
  kind: "save_workflow_draft" as const,
  commit_intent: { kind: "save_workflow_draft" as const, payload: {}, description: "save" },
};

// A bare confirm carries no commit_intent and no target — a plain question
// with no stable action identity, so the guard must never fire for it.
const BARE_CONFIRM_ARGS = {
  question: "Proceed?",
  kind: "generic" as const,
};

const SAVE_FP = authoringIntentFingerprint(
  { kind: CONFIRM_ARGS.kind, commit_intent: CONFIRM_ARGS.commit_intent, target: undefined },
  { workflow: WORKFLOW },
);

describe("declined-intent · confirm short-circuit", () => {
  test("declined-then-identical re-proposal returns confirmed:false without pausing", async () => {
    expect(SAVE_FP).not.toBeNull();
    const { ctx } = confirmCtx(draftWithDenial(SAVE_FP));
    const result = await askUserConfirmTool.execute(ctx, CONFIRM_ARGS);
    expect(result.ok).toBe(true);
    expect(result.pause).toBeUndefined();
    expect((result.data as { confirmed: boolean; already_declined?: boolean }).confirmed).toBe(
      false,
    );
    expect((result.data as { already_declined?: boolean }).already_declined).toBe(true);
  });

  test("an identical decline beats permission_mode=auto", async () => {
    const { ctx } = confirmCtx(draftWithDenial(SAVE_FP), "auto");
    const result = await askUserConfirmTool.execute(ctx, CONFIRM_ARGS);
    expect((result.data as { confirmed: boolean }).confirmed).toBe(false);
    expect((result.data as { already_declined?: boolean }).already_declined).toBe(true);
  });

  test("the guard is one-shot: firing clears the stamp so a genuine retry can prompt", async () => {
    const { ctx, current } = confirmCtx(draftWithDenial(SAVE_FP));
    // First identical re-proposal short-circuits...
    const first = await askUserConfirmTool.execute(ctx, CONFIRM_ARGS);
    expect((first.data as { already_declined?: boolean }).already_declined).toBe(true);
    // ...and clears the stamp, so the escape hatch is open.
    expect(current().state?.last_denied_intent ?? null).toBeNull();
    // A second identical proposal no longer short-circuits — it falls through
    // to the real pause path (which the fake ctx cannot service, so it throws).
    await expect(askUserConfirmTool.execute(ctx, CONFIRM_ARGS)).rejects.toThrow();
  });

  test("a bare confirm (no commit_intent, no target) is never guarded", async () => {
    // Stamp the bare confirm's own fingerprint, then re-propose it: the guard
    // must NOT fire, because a plain question has no stable action identity.
    const bareFp = authoringIntentFingerprint(
      { kind: BARE_CONFIRM_ARGS.kind, commit_intent: undefined, target: undefined },
      { workflow: WORKFLOW },
    );
    const { ctx } = confirmCtx(draftWithDenial(bareFp));
    // Falls through to the pause path (no DB) → throws; a short-circuit would
    // have returned already_declined without touching the DB.
    await expect(askUserConfirmTool.execute(ctx, BARE_CONFIRM_ARGS)).rejects.toThrow();
  });

  // The remaining fall-through cases must NOT short-circuit — they proceed to
  // the real `pauseForUserInput` path, which needs a DB the fake ctx lacks.
  // Reaching it (and throwing on the missing DB) is the proof that the guard
  // did not fire; a short-circuit would have returned before any DB access.
  test("no recorded denial → falls through to the normal pause path", async () => {
    const { ctx } = confirmCtx(draftWithDenial(null));
    await expect(askUserConfirmTool.execute(ctx, CONFIRM_ARGS)).rejects.toThrow();
  });

  test("edited draft (different fingerprint) → falls through, not short-circuited", async () => {
    // A denial recorded for the ORIGINAL workflow, proposed against an edited one.
    const editedState = createEmptyState("workflow");
    editedState.last_denied_intent = {
      fingerprint: SAVE_FP!,
      timestamp: "2026-07-16T00:00:00.000Z",
    };
    const editedDraft = {
      workflow: {
        name: "wf",
        steps: [
          { id: "s1", kind: "request" },
          { id: "s2", kind: "request" },
        ],
      },
      state: editedState,
    } as unknown as DraftDocument;
    const { ctx } = confirmCtx(editedDraft);
    await expect(askUserConfirmTool.execute(ctx, CONFIRM_ARGS)).rejects.toThrow();
  });
});

describe("declined-intent · normalize resume", () => {
  test("last_denied_intent survives the normalize round-trip", () => {
    const state = createEmptyState("workflow");
    state.last_denied_intent = {
      fingerprint: "abc123def456abcd",
      timestamp: "2026-07-16T00:00:00.000Z",
    };
    const revived = normalizeState({ state }, undefined);
    expect(revived.last_denied_intent).toEqual({
      fingerprint: "abc123def456abcd",
      timestamp: "2026-07-16T00:00:00.000Z",
    });
  });

  test("a malformed last_denied_intent normalizes to null", () => {
    const revived = normalizeState({ state: { last_denied_intent: { nope: true } } }, undefined);
    expect(revived.last_denied_intent).toBeNull();
  });
});

describe("declined-intent · decline write round-trip (DB)", () => {
  let ctx: ConversationTestCtx;
  beforeAll(async () => {
    ctx = await createConversationTestCtx("already_declined_write");
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  async function seedDraft(): Promise<string> {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active", loaded_skills: [] })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    const draft = {
      workflow: WORKFLOW,
      state: createEmptyState("workflow"),
    } as unknown as DraftDocument;
    await appendSnapshot(ctx.tenant_id, conv.id, draft, ctx.testDb.db);
    return conv.id;
  }

  test("declining ask_user_confirm stamps the intent fingerprint on the draft", async () => {
    const conversation_id = await seedDraft();
    await recordDeniedIntentIfDeclined({
      tenant_id: ctx.tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_confirm", input: CONFIRM_ARGS },
      output: { confirmed: false },
      db: ctx.testDb.db,
    });
    const reloaded = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
    const expected = authoringIntentFingerprint(
      { kind: CONFIRM_ARGS.kind, commit_intent: CONFIRM_ARGS.commit_intent, target: undefined },
      reloaded,
    );
    expect(reloaded.state?.last_denied_intent?.fingerprint).toBe(expected!);
  });

  test("a CONFIRMED answer records nothing", async () => {
    const conversation_id = await seedDraft();
    await recordDeniedIntentIfDeclined({
      tenant_id: ctx.tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_confirm", input: CONFIRM_ARGS },
      output: { confirmed: true },
      db: ctx.testDb.db,
    });
    const reloaded = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
    expect(reloaded.state?.last_denied_intent ?? null).toBeNull();
  });

  test("a decline on a non-confirm tool records nothing", async () => {
    const conversation_id = await seedDraft();
    await recordDeniedIntentIfDeclined({
      tenant_id: ctx.tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_text", input: CONFIRM_ARGS },
      output: { confirmed: false },
      db: ctx.testDb.db,
    });
    const reloaded = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
    expect(reloaded.state?.last_denied_intent ?? null).toBeNull();
  });

  test("declining a bare confirm (no commit_intent/target) records nothing", async () => {
    const conversation_id = await seedDraft();
    await recordDeniedIntentIfDeclined({
      tenant_id: ctx.tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_confirm", input: BARE_CONFIRM_ARGS },
      output: { confirmed: false },
      db: ctx.testDb.db,
    });
    const reloaded = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
    expect(reloaded.state?.last_denied_intent ?? null).toBeNull();
  });
});

// The suites above each cover one seam in isolation: the short-circuit against
// a hand-built draft, and the decline-write against a bare draft via a direct
// function call. Neither drives the two REAL turns end-to-end through the
// production call chain (respondElicitation -> applyElicitationOutcome ->
// recordDeniedIntentIfDeclined -> a second runConversationTurn reading the
// persisted draft through askUserConfirmTool). This closes that gap.
describe("declined-intent · wired through two real turns", () => {
  let ctx: ConversationTestCtx;
  beforeAll(async () => {
    ctx = await createConversationTestCtx("declined_intent_wired");
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  const PROPOSAL = {
    question: "Commit this workflow?",
    kind: "save_workflow_draft" as const,
    summary: "commit workflow",
    commit_intent: { kind: "save_workflow_draft" as const, payload: {}, description: "commit" },
  };

  async function seedReadyConversation(): Promise<string> {
    let draft = withWorkflowDraft(createEmptyDraftDocument(), {
      name: "declined-intent-workflow",
      slug: "declined-intent-workflow",
      steps: [
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression: "return input.input;",
        },
      ],
    });
    draft = withWorkflowInspection(draft);
    draft = withWorkflowValidation(draft, true, "Workflow draft valid.");
    draft = withLatestPreview(draft, { ok: true, step_id: "shape", summary: "Preview ok." });
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        owner_id: ctx.user_id,
        draft: draft as unknown as Record<string, unknown>,
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");
    return conversation.id;
  }

  function findToolResult(events: TurnEvent[], tool: string): Record<string, unknown> | undefined {
    const ev = events.find((e) => e.type === "tool_result" && e.tool === tool);
    return ev && ev.type === "tool_result" ? (ev.output as Record<string, unknown>) : undefined;
  }

  test("declining ask_user_confirm, then an identical re-proposal in a later turn, answers already_declined without re-pausing", async () => {
    const conversationId = await seedReadyConversation();

    getMockProvider().setConversePlan(conversationId, [
      { tool: "ask_user_confirm", args: PROPOSAL },
    ]);
    const turn1 = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversationId,
        actor_id: ctx.user_id,
        message: "please commit this workflow",
      },
      ctx.testDb.db,
    );
    expect(turn1.result.status).toBe("awaiting_input");
    const pendingId = turn1.result.pending_elicitation_id;
    expect(pendingId).toBeTruthy();

    const declined = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversationId,
        elicitation_id: pendingId!,
        actor_id: ctx.user_id,
        output: { confirmed: false },
      },
      ctx.testDb.db,
    );
    // The decline resumes the turn — not another pause on the same proposal.
    expect(declined.result.status).not.toBe("awaiting_input");

    // Second, BYTE-IDENTICAL proposal in the same conversation.
    getMockProvider().setConversePlan(conversationId, [
      { tool: "ask_user_confirm", args: PROPOSAL },
    ]);
    const turn2 = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversationId,
        actor_id: ctx.user_id,
        message: "please commit this workflow again",
      },
      ctx.testDb.db,
    );

    // The guard answered synchronously — no new pause on the repeat ask.
    expect(turn2.result.status).not.toBe("awaiting_input");
    const output = findToolResult(turn2.result.events, "ask_user_confirm");
    expect(output).toBeDefined();
    expect(output?.confirmed).toBe(false);
    expect(output?.already_declined).toBe(true);
  });

  test("an EDITED proposal (different commit_intent) after a decline still pauses normally", async () => {
    const conversationId = await seedReadyConversation();

    getMockProvider().setConversePlan(conversationId, [
      { tool: "ask_user_confirm", args: PROPOSAL },
    ]);
    const turn1 = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversationId,
        actor_id: ctx.user_id,
        message: "please commit this workflow",
      },
      ctx.testDb.db,
    );
    const pendingId = turn1.result.pending_elicitation_id;
    expect(pendingId).toBeTruthy();

    await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversationId,
        elicitation_id: pendingId!,
        actor_id: ctx.user_id,
        output: { confirmed: false },
      },
      ctx.testDb.db,
    );

    // A DIFFERENT commit_intent description → a different fingerprint —
    // must fall through to a normal pause, not the declined short-circuit.
    getMockProvider().setConversePlan(conversationId, [
      {
        tool: "ask_user_confirm",
        args: {
          ...PROPOSAL,
          commit_intent: { ...PROPOSAL.commit_intent, description: "commit (edited)" },
        },
      },
    ]);
    const turn2 = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversationId,
        actor_id: ctx.user_id,
        message: "commit the edited version instead",
      },
      ctx.testDb.db,
    );
    expect(turn2.result.status).toBe("awaiting_input");
    expect(turn2.result.pending_elicitation_id).toBeTruthy();
  });
});
