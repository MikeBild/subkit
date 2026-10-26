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
  test("save_workflow_draft is never reported confirmed without a write", async () => {
    let result: Awaited<ReturnType<typeof askUserConfirmTool.execute>> | null = null;
    try {
      result = await askUserConfirmTool.execute(ctx({ permission_mode: "auto" }) as never, {
        question: "Save the workflow?",
        kind: "save_workflow_draft",
      });
    } catch {}
    expect((result?.data as { auto_resolved?: boolean } | undefined)?.auto_resolved).not.toBe(true);
  });

  test("external_write is skipped in auto mode and says the user was not asked", async () => {
    const result = await askUserConfirmTool.execute(ctx({ permission_mode: "auto" }) as never, {
      question: "Run the request against prod?",
      kind: "external_write",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      confirmed: false,
      auto_skipped: true,
      user_asked: false,
      performed: null,
    });
    expect((result.data as { reason: string }).reason).toContain("NOT asked");
    expect((result.data as { auto_resolved?: unknown }).auto_resolved).toBeUndefined();
  });

  test("the description tells the model an auto-skipped question is no confirmation", () => {
    expect(askUserConfirmTool.description).toContain("auto_skipped=true");
    expect(askUserConfirmTool.description).toContain("never claim the user confirmed");
  });

  test("destructive=true STILL pauses in auto mode (safety carve-out)", async () => {
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
        } as never,
        { question: "Save the workflow?", kind: "save_workflow_draft" },
      );
    } catch {
      didPause = true;
    }
    expect(didPause).toBe(true);
  });
});
