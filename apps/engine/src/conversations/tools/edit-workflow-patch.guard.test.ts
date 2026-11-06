import { describe, expect, test } from "bun:test";
import { createEmptyDraftDocument } from "../authoring-state/index.ts";
import type { DraftDocument } from "../types.ts";
import { applyWorkflowPatchToDraft, editWorkflowPatchTool } from "./edit-workflow-patch.ts";
import type { ToolContext } from "./index.ts";

function draftWithOneStep(): DraftDocument {
  const d = createEmptyDraftDocument();
  d.workflow = {
    name: "wf",
    slug: "wf",
    steps: [{ kind: "request", id: "step1", method: "GET", url: "https://example.com/x" }],
  };
  return d;
}

function ctxFor(draft: DraftDocument): ToolContext {
  return {
    tenant_id: "t1",
    conversation_id: "c1",
    actor_id: null,
    getDraft: () => draft,
    setDraft: async () => {
      throw new Error("setDraft must not be called for a rejected patch");
    },
  } as unknown as ToolContext;
}

describe("edit_workflow_patch — steps must stay an array", () => {
  test("replacing /steps with an object is a typed patch_invalid, not a TypeError", async () => {
    const result = await applyWorkflowPatchToDraft(ctxFor(draftWithOneStep()), [
      { op: "replace", path: "/steps", value: { id: "not-a-list" } },
    ]);

    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string; message?: string };
    expect(data.error_code).toBe("patch_invalid");
    expect(data.message).toContain("steps must stay a list of step objects");
    expect(data.message).toContain("object");
  });

  test("replacing /steps with null is rejected the same way", async () => {
    const result = await applyWorkflowPatchToDraft(ctxFor(draftWithOneStep()), [
      { op: "replace", path: "/steps", value: null },
    ]);

    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string; message?: string };
    expect(data.error_code).toBe("patch_invalid");
    expect(data.message).toContain("null");
  });

  test("replacing /steps with a string is rejected", async () => {
    const result = await applyWorkflowPatchToDraft(ctxFor(draftWithOneStep()), [
      { op: "replace", path: "/steps", value: "steps" },
    ]);

    expect(result.ok).toBe(false);
    expect((result.data as { error_code?: string }).error_code).toBe("patch_invalid");
  });

  test("the rejected patch is echoed back so the model can see what it sent", async () => {
    const patches = [{ op: "replace" as const, path: "/steps", value: { id: "not-a-list" } }];
    const result = await applyWorkflowPatchToDraft(ctxFor(draftWithOneStep()), patches);

    expect((result.data as { patches?: unknown }).patches).toEqual(patches);
  });
});

test("invalid paths return compact actual step guidance without the draft payload", async () => {
  const draft = draftWithOneStep();
  draft.workflow.steps[0] = {
    kind: "request",
    id: "report",
    method: "PUT",
    connector_id: "00000000-0000-4000-8000-000000000001",
    s3: { key: "reports/file.json" },
    body: "PRIVATE_REPORT_PAYLOAD".repeat(10000),
  };
  const result = await applyWorkflowPatchToDraft(ctxFor(draft), [
    { op: "add", path: "/steps/9/config/s3/path_prefix", value: "reports/" },
  ]);
  expect(result.ok).toBe(false);
  const serialized = JSON.stringify(result.data);
  expect(serialized).not.toContain("PRIVATE_REPORT_PAYLOAD");
  expect(serialized.length).toBeLessThan(12000);
  expect(result.data).toMatchObject({
    error_code: "patch_invalid",
    step_paths: [{ id: "report", path: "/steps/0", storage_scope_path: "/steps/0/s3/scope" }],
  });
});

test("step-ID edits pass through the canonical validation and draft persistence path", async () => {
  let draft = draftWithOneStep();
  draft.workflow.steps = [
    { id: "build", kind: "transform", language: "javascript", expression: "return 1;" },
    {
      id: "store",
      kind: "request",
      method: "PUT",
      connector_id: "00000000-0000-4000-8000-000000000001",
      s3: { key: "reports/file.json" },
      body: "report",
    },
  ];
  const ctx = {
    ...ctxFor(draft),
    permission_mode: "auto",
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
  } as ToolContext;
  const result = await editWorkflowPatchTool.execute(ctx, {
    step_patches: [
      {
        step_id: "store",
        op: "add",
        path: "/s3/scope",
        value: { key_prefix: "reports/", max_bytes: 1000 },
      },
    ],
  });
  expect(result.ok).toBe(true);
  expect(draft.workflow.steps[1]).toMatchObject({
    id: "store",
    s3: { key: "reports/file.json", scope: { key_prefix: "reports/", max_bytes: 1000 } },
  });
  const before = JSON.stringify(draft);
  const rejected = await editWorkflowPatchTool.execute(ctx, {
    step_patches: [{ step_id: "store", op: "replace", path: "/method", value: "INVALID" }],
  });
  expect(rejected.ok).toBe(false);
  expect(JSON.stringify(draft)).toBe(before);
});

test("a failing JSON Patch op is named by index, operation, code and the nearest real path", async () => {
  const draft = draftWithOneStep();
  draft.workflow.steps[0] = {
    kind: "request",
    id: "report",
    method: "PUT",
    connector_id: "00000000-0000-4000-8000-000000000001",
    s3: { key: "reports/file.json" },
    body: "PRIVATE_REPORT_PAYLOAD",
  };
  const result = await applyWorkflowPatchToDraft(ctxFor(draft), [
    { op: "replace", path: "/steps/0/method", value: "PUT" },
    { op: "add", path: "/steps/0/s3x/scope", value: { key_prefix: "PRIVATE_SCOPE_VALUE" } },
  ]);

  expect(result.ok).toBe(false);
  expect(result.data).toMatchObject({
    error_code: "patch_invalid",
    failed_op_index: 1,
    failed_op: { op: "add", path: "/steps/0/s3x/scope" },
    code: "OPERATION_PATH_CANNOT_ADD",
    nearest_path: "/steps/0/s3/scope",
  });
  const serialized = JSON.stringify(result.data);
  expect(serialized).not.toContain("PRIVATE_SCOPE_VALUE");
  expect(serialized).not.toContain("PRIVATE_REPORT_PAYLOAD");
});

test("an unknown step_id lists the draft's known step ids", async () => {
  const result = await editWorkflowPatchTool.execute(ctxFor(draftWithOneStep()), {
    step_patches: [{ step_id: "missing", op: "replace", path: "/method", value: "POST" }],
  });

  expect(result.ok).toBe(false);
  expect(result.data).toMatchObject({
    error_code: "patch_target_invalid",
    known_step_ids: ["step1"],
  });
});
