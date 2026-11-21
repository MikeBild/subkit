import { describe, expect, test } from "bun:test";
import { askUserConfirmTool } from "../ask-user/confirm.ts";

interface MinimalCtx {
  ask_before_writing?: boolean;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  db: unknown;
  getDraft: () => unknown;
  setDraft: (d: unknown) => Promise<void>;
  task_run?: unknown;
}

function ctx(over: Partial<MinimalCtx> = {}): MinimalCtx {
  return {
    tenant_id: "t",
    conversation_id: "c",
    actor_id: null,
    db: {},
    getDraft: () => ({}),
    setDraft: async () => undefined,
    ...over,
  };
}

describe("ask_user_confirm — auto-resolve without the ask-before-writing rule", () => {
  test("save_workflow_draft is never reported confirmed without a write", async () => {
    let result: Awaited<ReturnType<typeof askUserConfirmTool.execute>> | null = null;
    try {
      result = await askUserConfirmTool.execute(ctx() as never, {
        question: "Save the workflow?",
        kind: "save_workflow_draft",
      });
    } catch {}
    expect((result?.data as { auto_resolved?: boolean } | undefined)?.auto_resolved).not.toBe(true);
  });

  test("external_write is skipped and says the user was not asked", async () => {
    const result = await askUserConfirmTool.execute(ctx() as never, {
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
    expect((result.data as { reason: string }).reason).toContain("input_partial");
    expect((result.data as { auto_resolved?: unknown }).auto_resolved).toBeUndefined();
  });

  test("a run_workflow commit_intent is asked instead of skipped", async () => {
    let result: Awaited<ReturnType<typeof askUserConfirmTool.execute>> | null = null;
    let reachedPausePath = false;
    try {
      result = await askUserConfirmTool.execute(ctx() as never, {
        question: "Send this report?",
        kind: "external_write",
        commit_intent: {
          kind: "run_workflow",
          payload: { workflow_id: "00000000-0000-0000-0000-000000000001" },
          description: "Send the report",
        },
      });
    } catch {
      reachedPausePath = true;
    }
    expect((result?.data as { auto_skipped?: boolean } | undefined)?.auto_skipped).not.toBe(true);
    expect(reachedPausePath).toBe(true);
  });

  test("the description tells the model an auto-skipped question is no confirmation", () => {
    expect(askUserConfirmTool.description).toContain("auto_skipped=true");
    expect(askUserConfirmTool.description).toContain("never claim the user confirmed");
  });

  test("destructive=true STILL pauses (safety carve-out)", async () => {
    let reachedPausePath = false;
    try {
      await askUserConfirmTool.execute(ctx() as never, {
        question: "Really delete?",
        kind: "generic",
        destructive: true,
      });
    } catch {
      reachedPausePath = true;
    }
    expect(reachedPausePath).toBe(true);
  });

  test("a plain question inside a task run is asked, never skipped", async () => {
    const marker = {
      task_id: "00000000-0000-4000-8000-000000000001",
      task_run_id: "00000000-0000-4000-8000-000000000002",
      environment: "dev",
      workflow_ids: [],
      connector_ids: [],
      web_search: false,
    };
    const contexts = [
      ctx({ task_run: marker }),
      ctx({ getDraft: () => ({ session: { task_run: marker } }) }),
    ];
    for (const context of contexts) {
      let result: Awaited<ReturnType<typeof askUserConfirmTool.execute>> | null = null;
      let reachedPausePath = false;
      try {
        result = await askUserConfirmTool.execute(context as never, {
          question: "Is this summary right?",
          kind: "generic",
        });
      } catch {
        reachedPausePath = true;
      }
      expect((result?.data as { auto_skipped?: boolean } | undefined)?.auto_skipped).not.toBe(true);
      expect(reachedPausePath).toBe(true);
    }
  });

  test("asking before writing keeps the manual confirm path even for non-destructive actions", async () => {
    let didPause = false;
    try {
      await askUserConfirmTool.execute(
        {
          ...ctx({ ask_before_writing: true }),
        } as never,
        { question: "Save the workflow?", kind: "save_workflow_draft" },
      );
    } catch {
      didPause = true;
    }
    expect(didPause).toBe(true);
  });
});
