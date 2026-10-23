import { describe, expect, test } from "bun:test";
import type { Db } from "../../../db/client.ts";
import {
  createEmptyDraftDocument,
  withLatestPreview,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../../authoring-state.ts";
import { saveApprovalReadiness } from "../../persistence/save-workflow-approval.ts";
import type { DraftDocument } from "../../types.ts";
import { buildDraftMutationPayload, workflowSaveReadiness } from "../authoring-contract.ts";

function checkedDraft(privacy?: "sensitive"): DraftDocument {
  const empty = createEmptyDraftDocument();
  const base = withWorkflowDraft(empty, {
    ...empty.workflow,
    name: "wf",
    slug: "wf",
    steps: [{ kind: "request", id: "step1", method: "GET", url: "https://example.com/x" }],
    ...(privacy ? { execution_privacy: privacy } : {}),
  });
  const inspected = withWorkflowInspection(base);
  const validated = withWorkflowValidation(inspected, true, "valid");
  return withLatestPreview(validated, {
    ok: true,
    summary: "preview ok",
  } as NonNullable<DraftDocument["latest_preview"]>);
}

function patched(draft: DraftDocument): DraftDocument {
  return withWorkflowDraft(draft, {
    ...draft.workflow,
    steps: [{ kind: "request", id: "step1", method: "GET", url: "https://example.com/y" }],
  });
}

describe("draft mutation readiness", () => {
  test("checked draft reports fresh inspect, validate and preview", () => {
    expect(workflowSaveReadiness(checkedDraft(), "fresh")).toEqual({
      inspect: "fresh",
      validate: "fresh",
      preview: "fresh",
      approval: "fresh",
    });
  });

  test("a patch turns every earlier check stale in the mutation payload", () => {
    const payload = buildDraftMutationPayload(patched(checkedDraft()), {
      resource_kind: "workflow",
      save_approval: "missing",
    });
    expect(payload.readiness).toEqual({
      inspect: "stale",
      validate: "stale",
      preview: "stale",
      approval: "missing",
    });
  });

  test("an unchecked draft reports missing checks", () => {
    const empty = createEmptyDraftDocument();
    const draft = withWorkflowDraft(empty, { ...empty.workflow, name: "wf", steps: [] });
    expect(workflowSaveReadiness(draft, "not_required")).toEqual({
      inspect: "missing",
      validate: "missing",
      preview: "missing",
      approval: "not_required",
    });
  });

  test("sensitive drafts do not require a chat preview", () => {
    expect(workflowSaveReadiness(patched(checkedDraft("sensitive")), "fresh").preview).toBe(
      "not_required",
    );
  });

  test("payload without a save approval status carries no readiness", () => {
    const payload = buildDraftMutationPayload(patched(checkedDraft()), {
      resource_kind: "workflow",
    });
    expect(payload.readiness).toBeUndefined();
  });

  test("connector mutations carry no workflow readiness", () => {
    const payload = buildDraftMutationPayload(createEmptyDraftDocument(), {
      resource_kind: "connector",
      save_approval: "fresh",
    });
    expect(payload.readiness).toBeUndefined();
  });

  test("auto mode needs no save approval and does not query", async () => {
    const db = new Proxy({} as Db, {
      get() {
        throw new Error("approval lookup must not run in auto mode");
      },
    });
    expect(
      await saveApprovalReadiness({
        db,
        tenant_id: "t1",
        conversation_id: "c1",
        permission_mode: "auto",
      }),
    ).toBe("not_required");
  });
});
