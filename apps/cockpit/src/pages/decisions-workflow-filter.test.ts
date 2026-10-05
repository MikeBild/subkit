import { describe, expect, test } from "bun:test";
import type { SkillCandidate } from "@/api/decisions";
import { decisionWorkflowId, isWholeQueue, skillDecision } from "@/pages/decisions-model";

const skill = (workflowId: string | null) =>
  skillDecision({
    id: "s1",
    tenant_id: "t",
    scope: "workflow",
    connector_id: null,
    endpoint_key: null,
    workflow_id: workflowId,
    pattern_kind: "repair_pattern",
    title: "Retry on 429",
    body: "",
    examples: [],
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    facts: null,
    evidence_count: 2,
    confidence: "medium",
    status: "proposed",
    promoted_skill_id: null,
    fingerprint: "f",
    version: 1,
    tags: [],
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  } as SkillCandidate);

describe("the decisions queue narrowed to one workflow", () => {
  test("a skill proposed for that workflow belongs to it", () => {
    expect(decisionWorkflowId(skill("wf-1"))).toBe("wf-1");
    expect(decisionWorkflowId(skill(null))).toBeNull();
  });

  test("'Alle' is not pressed while a link's workflow narrows the queue", () => {
    expect(isWholeQueue({ kinds: 0, focus: null, workflowFilter: null })).toBe(true);
    expect(isWholeQueue({ kinds: 0, focus: null, workflowFilter: "wf-1" })).toBe(false);
    expect(isWholeQueue({ kinds: 1, focus: null, workflowFilter: null })).toBe(false);
    expect(isWholeQueue({ kinds: 0, focus: "failing", workflowFilter: null })).toBe(false);
  });
});
