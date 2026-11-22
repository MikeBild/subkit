import { describe, expect, test } from "bun:test";
import { describePatchOps } from "../tools/ask-user/commit-intent.ts";
import {
  acceptedPatchResult,
  chatReadonlySynthetic,
  chatRefusesIntent,
  elicitationInputKind,
  isWriteShapedConfirm,
  noOpsAcceptedResult,
  readApprovedIndices,
  readFormValues,
  readPatches,
  readSubmittedWorkflowInput,
  writeNotDispatchedSynthetic,
} from "./auto-persist.ts";

describe("elicitation without commit_intent", () => {
  test("reads the input kind only when it is a string", () => {
    expect(elicitationInputKind({ kind: "external_write" })).toBe("external_write");
    expect(elicitationInputKind({ kind: 3 })).toBeNull();
    expect(elicitationInputKind({})).toBeNull();
    expect(elicitationInputKind(null)).toBeNull();
    expect(elicitationInputKind("external_write")).toBeNull();
  });

  test("only confirms of write kinds count as write-shaped", () => {
    expect(isWriteShapedConfirm("ask_user_confirm", "external_write")).toBe(true);
    expect(isWriteShapedConfirm("ask_user_confirm", "save_workflow_draft")).toBe(true);
    expect(isWriteShapedConfirm("ask_user_confirm", "generic")).toBe(false);
    expect(isWriteShapedConfirm("ask_user_confirm", null)).toBe(false);
    expect(isWriteShapedConfirm("ask_user_form", "external_write")).toBe(false);
  });

  test("an external write points at run_workflow first", () => {
    const { synthetic, description } = writeNotDispatchedSynthetic("external_write");
    expect(description).toBe(
      "write confirmation approved without commit_intent (kind=external_write)",
    );
    expect(synthetic).toStrictEqual({
      tool: "ask_user_confirm",
      ok: false,
      error_code: "write_not_dispatched",
      message:
        'You approved a write confirmation (kind=external_write) but it carried no commit_intent, so the harness performed NO write — nothing was persisted or executed. Do NOT report success. To actually perform it, re-issue ask_user_confirm with a commit_intent (e.g. {kind: "save_workflow_draft"} for a workflow step edit, {kind: "update_workflow_metadata", payload:{id,description}} for a metadata/description edit, {kind: "run_workflow", payload:{workflow_id,…}} for a run), OR call the underlying write tool now and confirm its result before telling the user it succeeded.',
      next_best_actions: ["run_workflow", "ask_user_confirm"],
      source: "harness_auto_persist",
    });
  });

  test("a workflow draft points at the confirm first", () => {
    const { synthetic } = writeNotDispatchedSynthetic("save_workflow_draft");
    expect(synthetic.next_best_actions).toStrictEqual(["ask_user_confirm", "save_workflow_draft"]);
  });
});

describe("read-only chat", () => {
  test("refuses every kind except run and held writes on chat", () => {
    expect(chatRefusesIntent("chat", "save_connector_draft")).toBe(true);
    expect(chatRefusesIntent("chat", "run_workflow")).toBe(false);
    expect(chatRefusesIntent("chat", "commit_held_workflow_writes")).toBe(false);
    expect(chatRefusesIntent("web", "save_connector_draft")).toBe(false);
    expect(chatRefusesIntent(undefined, "delete_workflow")).toBe(false);
  });

  test("names the refused kind", () => {
    expect(chatReadonlySynthetic("ask_user_confirm", "delete_workflow")).toStrictEqual({
      tool: "ask_user_confirm",
      ok: false,
      error_code: "chat_readonly_channel",
      message:
        "This chat channel is read-only: the approved delete_workflow was NOT performed — nothing was persisted or deleted. Do NOT report success. Tell the user to make this change via the subkit CLI or the web portal.",
      next_best_actions: ["cannot_help"],
      source: "harness_auto_persist",
    });
  });
});

describe("form values", () => {
  test("unwraps a values object", () => {
    expect(readFormValues({ values: { a: 1 }, b: 2 })).toStrictEqual({ a: 1 });
  });

  test("keeps the object when values is not an object", () => {
    expect(readFormValues({ values: [1], b: 2 })).toStrictEqual({ values: [1], b: 2 });
    expect(readFormValues({ values: null, b: 2 })).toStrictEqual({ values: null, b: 2 });
    expect(readFormValues({ values: "x" })).toStrictEqual({ values: "x" });
  });

  test("returns an empty object for non-objects", () => {
    expect(readFormValues(null)).toStrictEqual({});
    expect(readFormValues([1])).toStrictEqual({});
    expect(readFormValues("x")).toStrictEqual({});
  });

  test("only forms submit workflow input", () => {
    expect(readSubmittedWorkflowInput("ask_user_form", { a: 1 })).toStrictEqual({ a: 1 });
    expect(readSubmittedWorkflowInput("ask_user_confirm", { a: 1 })).toStrictEqual({});
  });
});

describe("patch selection", () => {
  test("reads sorted unique in-range integer indices", () => {
    expect(
      readApprovedIndices({ approved_indices: [2, 0, 2, -1, 3, 1.5, "1", 1] }, 3),
    ).toStrictEqual([0, 1, 2]);
    expect(readApprovedIndices({ approved_indices: [10, 2, 1] }, 11)).toStrictEqual([1, 2, 10]);
  });

  test("returns null without an index list", () => {
    expect(readApprovedIndices({ approved_indices: "0" }, 3)).toBeNull();
    expect(readApprovedIndices(null, 3)).toBeNull();
  });

  test("reads only non-empty patch lists", () => {
    const patches = [{ op: "add", path: "/a", value: 1 }];
    expect(readPatches(patches)).toBe(patches as never);
    expect(readPatches([])).toBeNull();
    expect(readPatches({ op: "add" })).toBeNull();
  });

  test("no accepted ops leave the draft unchanged", () => {
    const rejected = [{ op: "remove", path: "/steps/0" }];
    expect(noOpsAcceptedResult(rejected)).toStrictEqual({
      ok: false,
      error_code: "no_ops_accepted",
      message:
        "no patch ops were accepted — the draft was left unchanged. Re-propose the edit or accept at least one op.",
      data: { applied_count: 0, skipped_count: 1, skipped_ops: describePatchOps(rejected) },
    });
  });

  test("a partial acceptance reports the skipped ops", () => {
    const approved = [{ op: "add", path: "/a", value: 1 }];
    const rejected = [{ op: "remove", path: "/b" }];
    expect(acceptedPatchResult({ ok: true, data: { draft: 1 } }, approved, rejected)).toStrictEqual(
      {
        ok: true,
        data: {
          draft: 1,
          partial: true,
          applied_count: 1,
          skipped_count: 1,
          applied_ops: describePatchOps(approved),
          skipped_ops: describePatchOps(rejected),
        },
      },
    );
  });

  test("a full acceptance has no skipped ops", () => {
    const approved = [{ op: "add", path: "/a", value: 1 }];
    expect(acceptedPatchResult({ ok: true, data: null }, approved, [])).toStrictEqual({
      ok: true,
      data: {
        partial: false,
        applied_count: 1,
        skipped_count: 0,
        applied_ops: describePatchOps(approved),
      },
    });
  });

  test("non-object apply data is not spread into the result", () => {
    expect(acceptedPatchResult({ ok: true, data: "ab" }, [], [])).toStrictEqual({
      ok: true,
      data: { partial: false, applied_count: 0, skipped_count: 0, applied_ops: [] },
    });
  });

  test("a failed apply passes through", () => {
    const failed = { ok: false as const, error_code: "x", message: "m" };
    expect(acceptedPatchResult(failed, [{}], [])).toBe(failed);
  });
});
