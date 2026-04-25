// Locks the permission_mode=auto auto-resolve contract on
// ask_user_confirm. Without this, the model emitted the confirm tool,
// the loop paused, the elicit card surfaced — even though the user had
// flipped the bottom-bar chip to `auto` to opt out of approvals at
// session level. Session 9b9ea73b had the user typing "ja approve
// approve" three times before commit_draft committed.

import { describe, expect, test } from "bun:test";
import { askUserConfirmTool } from "../ask-user/confirm.ts";

interface MinimalCtx {
  permission_mode: "auto" | "ask" | "plan" | null;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  db: unknown;
  getDraft: () => unknown;
  setDraft: (d: unknown) => Promise<void>;
}

function ctx(over: Partial<MinimalCtx> = {}): MinimalCtx {
  return {
    permission_mode: null,
    tenant_id: "t",
    conversation_id: "c",
    actor_id: null,
    db: {},
    getDraft: () => ({}),
    setDraft: async () => undefined,
    ...over,
  };
}

describe("ask_user_confirm — permission_mode=auto auto-resolve", () => {
  test("commit_draft resolves confirmed:true in auto mode", async () => {
    const result = await askUserConfirmTool.execute(ctx({ permission_mode: "auto" }) as never, {
      question: "Save the workflow?",
      kind: "commit_draft",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { confirmed: boolean }).confirmed).toBe(true);
    expect((result.data as { auto_resolved: boolean }).auto_resolved).toBe(true);
  });

  test("external_write resolves confirmed:true in auto mode", async () => {
    const result = await askUserConfirmTool.execute(ctx({ permission_mode: "auto" }) as never, {
      question: "Run the request against prod?",
      kind: "external_write",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { confirmed: boolean }).confirmed).toBe(true);
  });

  test("destructive=true STILL pauses in auto mode (safety carve-out)", async () => {
    // Tool's own dangerous signal is the only gate that survives auto
    // — the model flags an action as destructive when it actually is
    // (deletion, revoke, irreversible side effect). With a stub ctx
    // pauseForUserInput throws when it tries to insert the elicit
    // row; the assertion here is that we REACH that path (i.e. we did
    // NOT take the auto-resolve short-circuit).
    let reachedPausePath = false;
    try {
      await askUserConfirmTool.execute(ctx({ permission_mode: "auto" }) as never, {
        question: "Really delete?",
        kind: "generic",
        destructive: true,
      });
    } catch {
      reachedPausePath = true;
    }
    expect(reachedPausePath).toBe(true);
  });

  test("ask mode keeps the manual confirm path even for non-destructive actions", async () => {
    let didPause = false;
    try {
      await askUserConfirmTool.execute(
        {
          ...ctx({ permission_mode: "ask" }),
          // pauseForUserInput needs DB + elicitation infra; in this
          // unit test we just observe the absence of auto_resolved.
        } as never,
        { question: "Save the workflow?", kind: "commit_draft" },
      );
    } catch {
      didPause = true;
    }
    // The function reached the pause path (which can't fully
    // execute in a stub ctx) — auto_resolved was NOT taken.
    expect(didPause).toBe(true);
  });
});
