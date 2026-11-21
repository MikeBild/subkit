import { describe, expect, test } from "bun:test";
import {
  isDetectedPattern,
  mayApproveProposal,
} from "@/features/knowledge/model/skill-proposal-model";

describe("skill proposals", () => {
  test("only detected patterns remain skill proposals; collected learnings belong to the intake", () => {
    expect(isDetectedPattern({ pattern_kind: "repair_pattern" })).toBe(true);
    expect(isDetectedPattern({ pattern_kind: "connector_capability" })).toBe(true);
    expect(isDetectedPattern({ pattern_kind: "session_learning" })).toBe(false);
    expect(isDetectedPattern({ pattern_kind: "knowledge_learning" })).toBe(false);
  });

  test("adopting a detected pattern activates a skill and needs skill:activate", () => {
    expect(mayApproveProposal(["skill:write", "skill:activate"])).toBe(true);
    expect(mayApproveProposal(["skill:write", "knowledge:write"])).toBe(false);
    expect(mayApproveProposal(["skill:activate"])).toBe(false);
  });
});
