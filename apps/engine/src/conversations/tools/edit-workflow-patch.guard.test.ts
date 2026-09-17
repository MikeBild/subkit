// Guards the `steps`-must-stay-an-array check in applyWorkflowPatchToDraft.
//
// A patch may legally target `/steps`, and nothing upstream guarantees the op
// leaves an ARRAY behind. Before the guard, a `replace` that put an object
// there flowed into `(patched.steps ?? []).some(...)` — `?? []` only covers
// null/undefined — and threw a raw TypeError that escaped as an untyped crash
// instead of a correctable envelope. Observed in production; this test is the
// proof the guard actually holds, which the comment alone was not.
//
// Pure logic: no DB, no draft persistence. setDraft throws so a regression that
// lets a malformed patch through the gate fails loudly rather than silently
// persisting a broken draft.

import { describe, expect, test } from "bun:test";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import type { DraftDocument } from "../types.ts";
import { applyWorkflowPatchToDraft } from "./edit-workflow-patch.ts";
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
  // The exact shape seen in production, repeatedly.
  test("replacing /steps with an object is a typed patch_invalid, not a TypeError", async () => {
    const result = await applyWorkflowPatchToDraft(ctxFor(draftWithOneStep()), [
      { op: "replace", path: "/steps", value: { id: "not-a-list" } },
    ]);

    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string; message?: string };
    expect(data.error_code).toBe("patch_invalid");
    expect(data.message).toContain("steps must stay a list of step objects");
    // The message names what was actually found, so the model can correct it.
    expect(data.message).toContain("object");
  });

  test("replacing /steps with null is rejected the same way", async () => {
    // `?? []` WOULD have swallowed null, so this case never crashed — but it
    // would have silently dropped every step. Same envelope, different reason.
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
