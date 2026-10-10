import { describe, expect, test } from "bun:test";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import { intakeReviewBlocksKnowledgeWrite } from "../sdk-wrap/invoke.ts";

describe("intake review knowledge-write guard", () => {
  test("allows normal knowledge authoring before a clip is read", () => {
    expect(
      intakeReviewBlocksKnowledgeWrite(createEmptyDraftDocument(), "create_knowledge_source"),
    ).toBe(false);
  });

  test("blocks every knowledge-admission shortcut after a direct chat read", () => {
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
      "approve_skill_candidate",
    ]) {
      expect(intakeReviewBlocksKnowledgeWrite(draft, tool)).toBe(true);
    }
    expect(intakeReviewBlocksKnowledgeWrite(draft, "create_intake_proposal")).toBe(false);
  });

  test("blocks knowledge admission after an intake list without exposing a clip", () => {
    const draft = {
      ...createEmptyDraftDocument(),
      session: { intake_review_active: true },
    };
    expect(intakeReviewBlocksKnowledgeWrite(draft, "create_knowledge_source")).toBe(true);
  });
});
