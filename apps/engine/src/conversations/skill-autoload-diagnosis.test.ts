// Diagnosis-driven autoload: a tool RESULT that names a gate diagnosis loads
// the skill that explains it. Read from the shipped seed, not a hand-built
// catalog, so the rule and the matcher cannot agree on a code the seed never
// declares.

import { describe, expect, test } from "bun:test";
import { loadEmbeddedSkillSeeds } from "../skills/seed.ts";
import { REPORT_MESSAGE_REFUSALS } from "../workflows/report-delivery-boundary.ts";
import {
  type ActivationRecord,
  autoloadForDiagnoses,
  autoloadForToolCall,
  autoloadForUserTurn,
  diagnosisCodesFromToolResult,
} from "./skill-autoload.ts";

function shippedCatalog(): ActivationRecord[] {
  const { skills, errors } = loadEmbeddedSkillSeeds();
  expect(errors).toEqual([]);
  return skills.map((skill) => ({
    slug: skill.slug,
    activates_when: skill.activates_when,
    maturity: skill.maturity,
    side_effects: skill.side_effects,
    tags: skill.tags,
  }));
}

describe("autoloadForDiagnoses", () => {
  test("a report delivery diagnosis loads governed-delivery", () => {
    for (const code of [
      "report_delivery_unprepared",
      "report_delivery_unobserved",
      "report_delivery_unreachable",
      "report_delivery_contradicted",
    ]) {
      expect(autoloadForDiagnoses([code], shippedCatalog(), [])).toContain("governed-delivery");
    }
  });

  test("every reason the report profile refuses a message loads governed-delivery", () => {
    // A new refusal reason the skill does not list would leave that refusal
    // unexplained; this fails the moment the two drift apart.
    for (const reason of [
      ...REPORT_MESSAGE_REFUSALS,
      "recipient_differs",
      "sender_differs",
      "content_type_differs",
    ]) {
      expect(autoloadForDiagnoses([reason], shippedCatalog(), [])).toContain("governed-delivery");
    }
  });

  test("an unrelated diagnosis loads nothing, an already-loaded skill is not repeated", () => {
    expect(autoloadForDiagnoses(["no_boundary"], shippedCatalog(), [])).not.toContain(
      "governed-delivery",
    );
    expect(
      autoloadForDiagnoses(["report_delivery_unobserved"], shippedCatalog(), ["governed-delivery"]),
    ).toEqual([]);
  });

  test("diagnosis rules never fire on a tool call or a user turn", () => {
    const catalog: ActivationRecord[] = [
      {
        slug: "only-diagnosis",
        activates_when: [{ kind: "diagnosis", codes: ["report_delivery_unobserved"] }],
        maturity: "stable",
        side_effects: "read",
        tags: [],
      },
    ];
    expect(autoloadForDiagnoses(["report_delivery_unobserved"], catalog, [])).toEqual([
      "only-diagnosis",
    ]);
    expect(autoloadForToolCall({ tool: "diagnose_workflow", input: {} }, catalog, [])).toEqual([]);
    expect(
      autoloadForUserTurn(
        { user_text: "report_delivery_unobserved", first_turn: true },
        catalog,
        [],
      ),
    ).toEqual([]);
  });
});

describe("diagnosisCodesFromToolResult", () => {
  test("reads code and reason from top-level and nested repair_guidance", () => {
    expect(
      diagnosisCodesFromToolResult({
        ok: true,
        repair_guidance: [{ step_id: "send", code: "report_delivery_unobserved" }],
        automation_readiness: {
          repair_guidance: [
            { step_id: "send", code: "no_boundary", reason: "report_message_multiple_recipients" },
          ],
        },
      }).sort(),
    ).toEqual(
      ["no_boundary", "report_delivery_unobserved", "report_message_multiple_recipients"].sort(),
    );
  });

  test("reads the codes of a gate diagnosis list", () => {
    expect(
      diagnosisCodesFromToolResult({
        workflow_id: "w",
        diagnoses: [
          { code: "execution_authority_changed", subject: { step_id: "send" } },
          { code: "report_delivery_unreachable", subject: { step_id: "send" } },
        ],
      }).sort(),
    ).toEqual(["execution_authority_changed", "report_delivery_unreachable"]);
  });

  test("a result without guidance yields nothing", () => {
    expect(diagnosisCodesFromToolResult({ ok: true, data: [1, 2] })).toEqual([]);
    expect(diagnosisCodesFromToolResult(null)).toEqual([]);
  });
});
