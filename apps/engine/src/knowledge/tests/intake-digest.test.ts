import { describe, expect, test } from "bun:test";
import { IntakeProposalTargetSchema } from "../../api/intake-schemas.ts";
import type { IntakeProposalTarget } from "../../db/schema/intake.ts";
import { proposalDigest } from "../intake-digest.ts";

const SKILL_ID = "00000000-0000-4000-8000-0000000000e1";

function digest(target: IntakeProposalTarget): string {
  return proposalDigest({ title: "Conventions", body: "Body", target, items: [] });
}

const TIMEZONE = {
  rule_id: "tenant-timezone",
  type: "timezone" as const,
  statement: "Schedules use Europe/Berlin.",
  payload: { value: "Europe/Berlin" },
};

describe("skill target rules in the proposal digest", () => {
  test("a target without rules keeps its digest and its parsed shape", () => {
    const raw = { skill: { skill_id: SKILL_ID, expected_version: 3, supersedes: [] } };
    const parsed = IntakeProposalTargetSchema.parse(raw) as IntakeProposalTarget;
    expect("rules" in (parsed as { skill: object }).skill).toBe(false);
    expect("domains" in (parsed as { skill: object }).skill).toBe(false);
    expect(digest(parsed)).toBe(digest(raw));
  });

  test("adding, changing or clearing rules changes the digest", () => {
    const base = { skill: { skill_id: SKILL_ID, expected_version: 3, supersedes: [] } };
    const withRule = { skill: { ...base.skill, rules: [TIMEZONE] } };
    const changed = {
      skill: { ...base.skill, rules: [{ ...TIMEZONE, payload: { value: "UTC" } }] },
    };
    const cleared = { skill: { ...base.skill, rules: [] } };
    const digests = new Set([digest(base), digest(withRule), digest(changed), digest(cleared)]);
    expect(digests.size).toBe(4);
  });

  test("the target rejects invalid rules", () => {
    expect(
      IntakeProposalTargetSchema.safeParse({
        skill: {
          skill_id: SKILL_ID,
          expected_version: 3,
          rules: [{ ...TIMEZONE, payload: { value: "Nowhere/City" } }],
        },
      }).success,
    ).toBe(false);
  });
});
