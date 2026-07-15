// Declined-intent guard — a "no" stays a "no" within one conversation.
//
// Three seams:
//   1. confirm.ts short-circuits an identical re-proposal (pure, fake ctx).
//   2. normalizeState revives `last_denied_intent` across resume.
//   3. recordDeniedIntentIfDeclined stamps the fingerprint on decline and
//      the round-trip through the draft store survives (per-file DB).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations } from "../db/schema/index.ts";
import { createEmptyState, normalizeState } from "./authoring-state/normalize.ts";
import { recordDeniedIntentIfDeclined } from "./declined-intent.ts";
import { appendSnapshot, loadDraft } from "./draft.ts";
import { authoringIntentFingerprint } from "./intent-fingerprint.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./tests/setup.ts";
import { askUserConfirmTool } from "./tools/ask-user/confirm.ts";
import type { ToolContext } from "./tools/index.ts";
import type { DraftDocument } from "./types.ts";

const WORKFLOW = { name: "wf", steps: [{ id: "s1", kind: "request" }] };

function draftWithDenial(fingerprint: string | null): DraftDocument {
  const state = createEmptyState("workflow");
  if (fingerprint)
    state.last_denied_intent = { fingerprint, timestamp: "2026-07-16T00:00:00.000Z" };
  return { workflow: WORKFLOW, state } as unknown as DraftDocument;
}

function confirmCtx(draft: DraftDocument): ToolContext {
  return {
    getDraft: () => draft,
    permission_mode: "ask",
  } as unknown as ToolContext;
}

const CONFIRM_ARGS = {
  question: "Save this workflow?",
  kind: "save_workflow_draft" as const,
  commit_intent: { kind: "save_workflow_draft" as const, payload: {}, description: "save" },
};

describe("declined-intent · confirm short-circuit", () => {
  test("declined-then-identical re-proposal returns confirmed:false without pausing", async () => {
    const fp = authoringIntentFingerprint(
      { kind: CONFIRM_ARGS.kind, commit_intent: CONFIRM_ARGS.commit_intent, target: undefined },
      { workflow: WORKFLOW },
    );
    expect(fp).not.toBeNull();
    const result = await askUserConfirmTool.execute(confirmCtx(draftWithDenial(fp)), CONFIRM_ARGS);
    expect(result.ok).toBe(true);
    expect(result.pause).toBeUndefined();
    expect((result.data as { confirmed: boolean; already_declined?: boolean }).confirmed).toBe(
      false,
    );
    expect((result.data as { already_declined?: boolean }).already_declined).toBe(true);
  });

  test("an identical decline beats permission_mode=auto", async () => {
    const fp = authoringIntentFingerprint(
      { kind: CONFIRM_ARGS.kind, commit_intent: CONFIRM_ARGS.commit_intent, target: undefined },
      { workflow: WORKFLOW },
    );
    const ctx = {
      getDraft: () => draftWithDenial(fp),
      permission_mode: "auto",
    } as unknown as ToolContext;
    const result = await askUserConfirmTool.execute(ctx, CONFIRM_ARGS);
    expect((result.data as { confirmed: boolean }).confirmed).toBe(false);
    expect((result.data as { already_declined?: boolean }).already_declined).toBe(true);
  });

  // The fall-through cases must NOT short-circuit — they proceed to the real
  // `pauseForUserInput` path, which needs a DB the fake ctx lacks. Reaching
  // it (and throwing on the missing DB) is the proof that the guard did not
  // fire; a short-circuit would have returned before any DB access.
  test("no recorded denial → falls through to the normal pause path", async () => {
    await expect(
      askUserConfirmTool.execute(confirmCtx(draftWithDenial(null)), CONFIRM_ARGS),
    ).rejects.toThrow();
  });

  test("edited draft (different fingerprint) → falls through, not short-circuited", async () => {
    // Record a denial for the ORIGINAL workflow, then propose against an edited one.
    const originalFp = authoringIntentFingerprint(
      { kind: CONFIRM_ARGS.kind, commit_intent: CONFIRM_ARGS.commit_intent, target: undefined },
      { workflow: WORKFLOW },
    );
    const editedState = createEmptyState("workflow");
    editedState.last_denied_intent = {
      fingerprint: originalFp!,
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
    await expect(
      askUserConfirmTool.execute(confirmCtx(editedDraft), CONFIRM_ARGS),
    ).rejects.toThrow();
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
});
