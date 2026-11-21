import { describe, expect, test } from "bun:test";
import type { PatchCandidate, SkillCandidate } from "@/api/decisions";
import type { TranslationKey } from "@/lib/i18n";
import { buildNameIndex, EMPTY_NAME_INDEX } from "@/lib/name-index";
import { heldForWorkflow, reviewDecisionItems } from "./review-decisions";

const CREATED = "2026-11-17T12:00:00.000Z";

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  values ? `${key} ${JSON.stringify(values)}` : key;

function patch(id: string, extra: Partial<PatchCandidate> = {}): PatchCandidate {
  return {
    id,
    tenant_id: "t",
    workflow_id: "wf-1",
    workflow_name: "Daily report",
    connector_id: null,
    endpoint_key: null,
    classification: "safe",
    status: "proposed",
    fixture_id: null,
    diff: { proposal: { kind: "update_field_path", description: "Follow the renamed field" } },
    closed_reason: null,
    closed_against_version_id: null,
    closed_at: null,
    created_at: CREATED,
    updated_at: CREATED,
    reviewable: true,
    ...extra,
  } as PatchCandidate;
}

function skill(id: string): SkillCandidate {
  return {
    id,
    tenant_id: "t",
    scope: "workflow",
    connector_id: null,
    endpoint_key: null,
    workflow_id: "wf-1",
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
    proposed_by: null,
    created_at: CREATED,
    updated_at: CREATED,
    reviewable: true,
  } as SkillCandidate;
}

describe("review decisions", () => {
  test("patches and skills become one list, each candidate once", () => {
    const names = buildNameIndex([{ id: "wf-1", name: "Daily report" }], []);
    const items = reviewDecisionItems(
      { patches: [patch("p1"), patch("p1")], skills: [skill("s1")] },
      names,
      t,
    );
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual(["patch:p1", "skill:s1"]);
    expect(items[0]?.title).toContain("Daily report");
    expect(items[1]?.target).toBe("Daily report");
  });

  test("a patch the engine marks as not reviewable is left out", () => {
    const items = reviewDecisionItems(
      { patches: [patch("p2", { reviewable: false } as Partial<PatchCandidate>)], skills: [] },
      EMPTY_NAME_INDEX,
      t,
    );
    expect(items).toEqual([]);
  });

  test("only the reviewed workflow's held schedules are shown", () => {
    const held = [{ workflow_id: "wf-1" }, { workflow_id: "wf-2" }, { workflow_id: null }];
    expect(heldForWorkflow(held, "wf-1")).toEqual([{ workflow_id: "wf-1" }]);
  });
});
