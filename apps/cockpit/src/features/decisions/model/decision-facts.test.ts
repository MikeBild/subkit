import { expect, test } from "bun:test";
import type { PatchCandidate } from "@/api/decisions";
import {
  approveBlockedReason,
  changeFacts,
  changeRows,
  humanStep,
  patchChangeKind,
  patchTitle,
  suggestionTargets,
} from "./decision-facts.ts";
import { item, PATCH_EVIDENCE } from "./decisions-model-fixtures.ts";

test("decision facts retain the readable patch identity and approval gates", () => {
  const candidate = {
    id: "candidate-1",
    tenant_id: "tenant-1",
    workflow_id: "workflow-1",
    workflow_name: null,
    connector_id: null,
    endpoint_key: null,
    classification: "safe",
    status: "proposed",
    fixture_id: null,
    diff: {
      proposal: { kind: "rename_param" },
      drift_signal: { kind: "schema_diff", fixer: "fix" },
    },
    closed_reason: null,
    closed_against_version_id: null,
    closed_at: null,
    accepted_operations: null,
    accepted_digest: null,
    created_at: "2026-11-09T00:00:00.000Z",
    updated_at: "2026-11-09T00:00:00.000Z",
  } satisfies PatchCandidate;
  expect(patchChangeKind(candidate)).toEqual({
    proposalKind: "rename_param",
    driftKind: "schema_diff",
    fixer: "fix",
  });
  expect(
    patchChangeKind({
      ...candidate,
      diff: { proposal: { kind: " " }, drift_signal: { kind: "", fixer: " " } },
    }),
  ).toEqual({ proposalKind: null, driftKind: null, fixer: null });
  expect(patchChangeKind({ ...candidate, diff: null })).toEqual({
    proposalKind: null,
    driftKind: null,
    fixer: null,
  });
  const callableDiff = Object.assign(() => undefined, { proposal: { kind: "callable" } });
  expect(patchChangeKind({ ...candidate, diff: callableDiff })).toEqual({
    proposalKind: null,
    driftKind: null,
    fixer: null,
  });
  expect(patchTitle({ workflow: " workflow ", change: " rename " })).toEqual({
    key: "decisions.patchTitle",
    params: { workflow: "workflow", change: "rename" },
  });
  expect(patchTitle({ workflow: "workflow", change: null }).key).toBe(
    "decisions.patchTitleWorkflow",
  );
  expect(patchTitle({ workflow: null, change: "rename" }).key).toBe("decisions.patchTitleChange");
  expect(patchTitle({ workflow: "workflow", change: null })).toEqual({
    key: "decisions.patchTitleWorkflow",
    params: { workflow: "workflow" },
  });
  expect(patchTitle({ workflow: null, change: "rename" })).toEqual({
    key: "decisions.patchTitleChange",
    params: { change: "rename" },
  });
  expect(patchTitle({ workflow: " ", change: " " }).key).toBe("decisions.fallbackTitle.patch");
  const allowed = {
    canDecide: true,
    expanded: true,
    kind: "patch" as const,
    reviewDigest: null,
    preview: { reviewable: true, review_digest: "digest" },
  };
  expect(approveBlockedReason({ ...allowed, canDecide: false })).toBe("decisions.approveNeedsRole");
  expect(approveBlockedReason({ ...allowed, expanded: false })).toBe(
    "decisions.approveNeedsReview",
  );
  expect(approveBlockedReason({ ...allowed, preview: { reviewable: false } })).toBe(
    "decisions.approveNotReviewable",
  );
  expect(approveBlockedReason({ ...allowed, kind: "skill", reviewDigest: null })).toBe(
    "decisions.approveNotReviewable",
  );
  expect(approveBlockedReason(allowed)).toBeNull();
  expect(
    approveBlockedReason({ ...allowed, preview: { reviewable: true, review_digest: null } }),
  ).toBe("decisions.approveNotReviewable");
});

test("decision facts expose only unresolved workflow suggestions and readable changes", () => {
  const conversationEvidence = {
    conversationId: "conversation-1",
    targetWorkflowId: null,
    targetConnectorId: null,
    workflowId: "workflow-5",
  };
  const withWorkflow = item("patch", 1, "patch", {
    reviewable: false,
    detail: { kind: "patch", evidence: { ...PATCH_EVIDENCE, workflowId: "workflow-1" } },
  });
  const withoutWorkflow = item("skill", 1, "skill", { reviewable: false });
  const skillWithWorkflow = item("skill", 1, "skill-with-workflow", {
    reviewable: false,
    detail: {
      kind: "skill",
      evidence: {
        scope: "workflow",
        workflowId: "workflow-2",
        connectorId: null,
        endpointKey: null,
        evidenceCount: null,
      },
      body: "",
      sections: { examples: [], bestPractices: [], pitfalls: [], docRefs: [], tags: [] },
    },
  });
  expect(
    suggestionTargets([withWorkflow, withoutWorkflow, skillWithWorkflow, item("conversation", 1)]),
  ).toEqual([
    { item: withWorkflow, workflowId: "workflow-1" },
    { item: skillWithWorkflow, workflowId: "workflow-2" },
  ]);
  expect(
    suggestionTargets([
      item("conversation", 1, "conversation-hidden", {
        reviewable: false,
        detail: { kind: "patch", evidence: { ...PATCH_EVIDENCE, workflowId: "workflow-4" } },
      }),
      item("patch", 1, "patch-reviewable", {
        reviewable: true,
        detail: { kind: "patch", evidence: { ...PATCH_EVIDENCE, workflowId: "workflow-3" } },
      }),
      item("patch", 1, "patch-no-workflow", {
        reviewable: false,
        detail: { kind: "patch", evidence: PATCH_EVIDENCE },
      }),
      item("patch", 1, "patch-conversation-detail", {
        reviewable: false,
        detail: {
          kind: "conversation",
          evidence: conversationEvidence,
          question: null,
          tool: null,
        },
      }),
    ]),
  ).toEqual([]);
  expect(humanStep("  send---weekly___report  ")).toBe("send weekly report");
  expect(humanStep("send__two   words")).toBe("send two words");
  expect(humanStep("  Ünicode___漢字--workflow  ")).toBe("Ünicode 漢字 workflow");
  expect(changeFacts({}, { selector: "items" }, ["selector"])).toEqual([
    { path: "selector", inline: { before: "—", after: "items" }, rows: [] },
  ]);
  const [long] = changeFacts({ body: "old" }, { body: "next\nline" }, ["body"]);
  expect(long?.inline).toBeNull();
  expect(changeFacts({}, {}, null)).toEqual([]);
  expect(changeFacts({}, {}, ["a", "b", "c", "d"])).toHaveLength(3);
  expect(changeFacts({ nested: null }, { nested: { value: "x" } }, ["nested.value"])[0]).toEqual({
    path: "nested.value",
    inline: { before: "—", after: "x" },
    rows: [],
  });
  expect(changeFacts(null, { nested: { value: "x" } }, ["nested.value"])[0]).toEqual({
    path: "nested.value",
    inline: { before: "—", after: "x" },
    rows: [],
  });
  expect(changeFacts("abc", {}, ["length"])[0]).toEqual({
    path: "length",
    inline: { before: "—", after: "—" },
    rows: [],
  });
  expect(
    changeFacts({ value: "a".repeat(120) }, { value: "b".repeat(120) }, ["value"])[0]?.inline,
  ).not.toBeNull();
  expect(
    changeFacts({ value: "a".repeat(121) }, { value: "b".repeat(121) }, ["value"])[0]?.inline,
  ).toBeNull();
  expect(
    changeFacts({ value: "a".repeat(121) }, { value: "short" }, ["value"])[0]?.inline,
  ).toBeNull();
  expect(changeRows([{ path: "x", inline: { before: "a", after: "b" }, rows: [] }])).toEqual([
    { type: "removed", text: "a" },
    { type: "added", text: "b" },
  ]);
  expect(
    changeRows([{ path: "body", inline: null, rows: [{ type: "context", text: "kept" }] }]),
  ).toEqual([{ type: "context", text: "kept" }]);
});
