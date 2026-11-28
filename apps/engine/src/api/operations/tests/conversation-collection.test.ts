import { describe, expect, test } from "bun:test";
import type { z } from "@hono/zod-openapi";
import { pendingPrompt } from "../../../conversations/resume.ts";
import { askUserConfirmTool } from "../../../conversations/tools/ask-user/confirm.ts";
import { CONFIRM_PROMPT_KINDS } from "../../../http/routes/conversations/schemas.ts";
import { confirmPromptFields } from "../conversation-collection.ts";

describe("confirmPromptFields", () => {
  test("carries the confirm kind and the diffs of a stored ask_user_confirm input", () => {
    expect(
      confirmPromptFields({
        question: "Apply?",
        kind: "partial_diff_approval",
        diffs: [{ label: "replace /steps/0", preview: "return 2;" }, { label: "remove /steps/1" }],
      }),
    ).toEqual({
      kind: "partial_diff_approval",
      diffs: [{ label: "replace /steps/0", preview: "return 2;" }, { label: "remove /steps/1" }],
    });
  });

  test("keeps only well-formed diffs and drops a non-string preview", () => {
    expect(
      confirmPromptFields({
        kind: "generic",
        diffs: [{ label: "ok", preview: 3 }, { preview: "no label" }, null, "text", ["x"]],
      }),
    ).toEqual({ kind: "generic", diffs: [{ label: "ok" }] });
  });

  test("a stored input without kind has the confirm tool's default kind", () => {
    expect(confirmPromptFields({ question: "Continue?" })).toEqual({ kind: "generic" });
  });

  test("leaves out an unknown kind, an empty diff list and non-object inputs", () => {
    expect(confirmPromptFields({ kind: "made_up", diffs: [] })).toEqual({});
    expect(confirmPromptFields({ kind: 7, diffs: "nope" })).toEqual({});
    expect(confirmPromptFields(null)).toEqual({});
    expect(confirmPromptFields("text")).toEqual({});
    expect(confirmPromptFields([{ kind: "generic" }])).toEqual({});
  });

  test("carries the kind of a paused local mcp command confirm", () => {
    expect(confirmPromptFields({ question: "Run it?", kind: "mcp_local_command" })).toEqual({
      kind: "mcp_local_command",
    });
  });

  test("the contract lists exactly the kinds the confirm tool accepts", () => {
    const shape = (askUserConfirmTool.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    const kind = shape.kind as unknown as { unwrap(): { options: readonly string[] } };
    expect([...kind.unwrap().options].sort()).toEqual([...CONFIRM_PROMPT_KINDS].sort());
    expect(askUserConfirmTool.inputSchema.parse({ question: "?" })).toMatchObject({
      kind: "generic",
    });
  });
});

describe("pendingPrompt for a confirm question", () => {
  const input = {
    question: "Apply?",
    kind: "partial_diff_approval",
    diffs: [{ label: "replace /steps/0", preview: "return 2;" }, { label: 5 }, null],
  };

  test("copies the confirm kind and the well-formed diffs of an ask_user_confirm input", () => {
    expect(pendingPrompt(input, "ask_user_confirm").prompt).toEqual({
      question: "Apply?",
      kind: "partial_diff_approval",
      diffs: [{ label: "replace /steps/0", preview: "return 2;" }],
    });
  });

  test("copies the kind of a local mcp command confirm", () => {
    expect(
      pendingPrompt({ question: "Run it?", kind: "mcp_local_command" }, "ask_user_confirm").prompt,
    ).toEqual({ question: "Run it?", kind: "mcp_local_command" });
  });

  test("ignores kind and diffs of other questions and of an unnamed tool", () => {
    expect(pendingPrompt(input, "ask_user_form").prompt).toEqual({ question: "Apply?" });
    expect(pendingPrompt(input).prompt).toEqual({ question: "Apply?" });
  });

  test("leaves out an empty diff list and a non-string kind", () => {
    expect(
      pendingPrompt({ question: "Apply?", kind: 3, diffs: [] }, "ask_user_confirm").prompt,
    ).toEqual({ question: "Apply?" });
  });
});
