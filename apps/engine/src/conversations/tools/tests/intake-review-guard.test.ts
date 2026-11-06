import { describe, expect, test } from "bun:test";
import { createEmptyDraftDocument } from "../../authoring-state/index.ts";
import { getTool } from "../index.ts";
import { INTAKE_REVIEW_BLOCKED_WRITES, intakeReviewBlocksWrite } from "../sdk-wrap/invoke.ts";

const SKILL_MUTATIONS = [
  "update_skill",
  "delete_skill",
  "approve_skill_candidate",
  "reject_skill_candidate",
];

describe("intake review write guard", () => {
  test("allows normal knowledge and skill authoring before a clip is read", () => {
    for (const tool of ["create_knowledge_source", ...SKILL_MUTATIONS])
      expect(intakeReviewBlocksWrite(createEmptyDraftDocument(), tool)).toBe(false);
  });

  test("every blocked name is a registered conversation tool", () => {
    for (const name of INTAKE_REVIEW_BLOCKED_WRITES) expect(getTool(name)?.name).toBe(name);
  });

  test("blocks every knowledge and skill admission shortcut after a direct chat read", () => {
    const draft = {
      ...createEmptyDraftDocument(),
      session: { intake_item_ids: ["10000000-0000-4000-8000-000000000001"] },
    };
    for (const tool of [
      "create_knowledge_source",
      "update_knowledge_source",
      "analyze_knowledge_source",
      "delete_knowledge_source",
      "save_learning",
      ...SKILL_MUTATIONS,
    ]) {
      expect(intakeReviewBlocksWrite(draft, tool)).toBe(true);
    }
    expect(intakeReviewBlocksWrite(draft, "create_intake_proposal")).toBe(false);
  });

  test("blocks admission after an intake list without exposing a clip", () => {
    const draft = {
      ...createEmptyDraftDocument(),
      session: { intake_review_active: true },
    };
    expect(intakeReviewBlocksWrite(draft, "create_knowledge_source")).toBe(true);
    expect(intakeReviewBlocksWrite(draft, "update_skill")).toBe(true);
  });
});
