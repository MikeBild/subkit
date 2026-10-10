import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  INTAKE_CHAT_PROMPTS,
  intakeChatPrompt,
  intakeNextAction,
  intakeStateLabelKey,
  intakeTargetDetails,
  intakeTargetTopic,
  isIntakeCategory,
  proposalMatchesVisibleItems,
  publishedDate,
} from "./intake-model";

describe("intake model", () => {
  test("keeps the category name in the human-facing chat start", () => {
    expect(intakeChatPrompt("Recherche", (key, values) => translate("de", key, values))).toBe(
      "Schau meine neuen Einträge in „Recherche“ durch. Welche davon helfen uns? Zeige zu jedem Vorschlag den genauen Text, Quellen und das Wissensziel zur Bestätigung.",
    );
  });

  test("offers category-aware review questions without technical selection data", () => {
    for (const kind of INTAKE_CHAT_PROMPTS) {
      const prompt = intakeChatPrompt(
        "Recherche",
        (key, values) => translate("de", key, values),
        kind,
      );
      expect(prompt).toContain("Recherche");
      expect(prompt).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/i);
    }
  });

  test("accepts only explicit shared-category input", () => {
    expect(isIntakeCategory("research-notes")).toBe(true);
    expect(isIntakeCategory("Research notes")).toBe(false);
    expect(isIntakeCategory("platform")).toBe(false);
    expect(isIntakeCategory("a".repeat(40))).toBe(true);
    expect(isIntakeCategory("a".repeat(41))).toBe(false);
  });

  test("keeps a publication label that is not a machine date", () => {
    expect(publishedDate("Spring issue", () => "—")).toBe("Spring issue");
    expect(publishedDate("2026-01-02T00:00:00.000Z", () => "2 January 2026")).toBe(
      "2 January 2026",
    );
  });

  test("does not call unassigned knowledge available to coding-agent briefings", () => {
    expect(intakeTargetTopic(undefined, undefined)).toBeNull();
    expect(intakeTargetTopic("other", [])).toBeNull();
    expect(intakeTargetTopic("product-guides", ["domain:engine"])).toBe("product-guides");
    expect(intakeTargetTopic(undefined, ["domain:engine"])).toBe("engine");
  });

  test("keeps the exact proposed category and tags for human admission review", () => {
    expect(
      intakeTargetDetails("incident-review", ["incident-review", "domain:operations"]),
    ).toEqual({ category: "incident-review", tags: "incident-review, domain:operations" });
  });

  test("shows category-matched proposals and preserves a focused handoff", () => {
    const visible = new Set(["item-a"]);
    expect(proposalMatchesVisibleItems(["item-a"], visible, null, "proposal-a")).toBe(true);
    expect(proposalMatchesVisibleItems(["item-b"], visible, null, "proposal-b")).toBe(false);
    expect(proposalMatchesVisibleItems(["item-b"], visible, "proposal-b", "proposal-b")).toBe(true);
  });

  test("does not imply that category membership admits a clip", () => {
    expect(intakeStateLabelKey("collected")).toBe("intake.state.collected");
    expect(intakeNextAction("collected")).toBe("review");
    expect(intakeNextAction("admitted")).toBe("openKnowledge");
  });
});

test("referenced record instructions do not repeat record labels", () => {
  const keys = [
    "intake.itemChatPrompt",
    "detail.changeRecordPrompt",
    "schedule.chatPrompt",
    "automation.invalidPrompt",
  ] as const;
  for (const locale of ["de", "en"] as const) {
    for (const key of keys) {
      const prompt = translate(locale, key, { name: "Specific record", title: "Specific record" });
      expect(prompt).not.toContain("Specific record");
      expect(prompt).not.toContain("{name}");
      expect(prompt).not.toContain("{title}");
    }
  }
});
