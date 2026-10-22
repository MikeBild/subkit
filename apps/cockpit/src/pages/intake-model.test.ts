import { describe, expect, test } from "bun:test";
import type { IntakeProposalTarget } from "@/api/intake";
import { routerTarget } from "@/app/links";
import { translate } from "@/lib/i18n";
import {
  changedSkillLine,
  INTAKE_CHAT_PROMPTS,
  intakeCategoryFromSearch,
  intakeChatPrompt,
  intakeConfirmPermissions,
  intakeEvents,
  intakeNextAction,
  intakeOrigin,
  intakeStateLabelKey,
  intakeStripState,
  intakeTargetDetails,
  intakeTargetTopic,
  isIntakeCategory,
  mayConfirmIntakeProposal,
  newSkillLine,
  proposalMatchesVisibleItems,
  publishedDate,
  sessionLabel,
  sessionPlace,
  sessionSnapshot,
  skillBodyChange,
  skillTargetIds,
} from "./intake-model";

const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);
const en = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("en", key, values);
const SKILL = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const knowledgeTarget: IntakeProposalTarget = { name: "Betrieb", category: "betrieb" };
const newSkill: IntakeProposalTarget = {
  skill: {
    new: { title: "Rollbacks", scope: "global", tags: [], category: "betrieb" },
    supersedes: [],
  },
};
const replacingSkill: IntakeProposalTarget = {
  skill: {
    skill_id: SKILL,
    expected_version: 3,
    supersedes: [{ skill_id: OLD, expected_version: 2 }],
  },
};

describe("intake model", () => {
  test("keeps the category name in the human-facing chat start", () => {
    expect(intakeChatPrompt("Recherche", (key, values) => translate("de", key, values))).toBe(
      "Schau meine neuen Einträge in „Recherche“ durch. Welche davon helfen uns? Schlage vor, was wir übernehmen sollten, als Wissen oder als Skill, mit genauem Text, Quellen und Ziel zur Bestätigung.",
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

  test("the collected-material attention link opens the view it counts", () => {
    const target = routerTarget("/cockpit/intake?category=all");
    expect(target).toEqual({ to: "/intake", search: { category: "all" } });
    expect(intakeCategoryFromSearch(target.search ?? {})).toBe("all");
    expect(en("overview.object.intake")).toBe("Collected material");
    expect(de("overview.object.intake")).not.toMatch(/Eingang|Inbox/);
  });

  test("reads the requested category view from the address", () => {
    expect(intakeCategoryFromSearch("?category=all")).toBe("all");
    expect(intakeCategoryFromSearch({ category: "betrieb" })).toBe("betrieb");
    expect(intakeCategoryFromSearch("?category=Not%20Valid")).toBeNull();
    expect(intakeCategoryFromSearch("?item=x")).toBeNull();
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

describe("collected sessions and confirmation targets", () => {
  test("origin separates sessions from clips without becoming a category", () => {
    expect(intakeOrigin({ origin: "session" })).toBe("session");
    expect(intakeOrigin({ origin: "capture" })).toBe("clip");
    expect(intakeOrigin({ origin: "restored_draft" })).toBe("clip");
  });

  test("session details name repository and domains but never a clip address", () => {
    const session = sessionSnapshot({
      title: "Rollbacks",
      captured_at: "2026-01-02T00:00:00.000Z",
      body: "Rollback first.",
      origin: "session",
      agent: "claude-code",
      session_id: "s-1",
      repo: "subkit",
      domains: ["betrieb"],
      evidence_excerpt: "we rolled back",
    });
    expect(session?.agent).toBe("claude-code");
    expect(session ? sessionPlace(session) : null).toBe("subkit · betrieb");
    expect(sessionPlace({ repo: null, domains: [] })).toBeNull();
    expect(
      sessionSnapshot({
        title: "Clip",
        captured_at: "2026-01-02T00:00:00.000Z",
        body: "x",
        origin: "capture",
        source_url: "https://example.test/clip",
      }),
    ).toBeNull();
  });

  test("a knowledge target needs knowledge:write, a skill target never does", () => {
    expect(intakeConfirmPermissions(knowledgeTarget)).toEqual([
      "intake:confirm",
      "knowledge:write",
    ]);
    expect(mayConfirmIntakeProposal(knowledgeTarget, ["intake:confirm", "knowledge:write"])).toBe(
      true,
    );
    expect(mayConfirmIntakeProposal(knowledgeTarget, ["intake:confirm", "skill:write"])).toBe(
      false,
    );
    expect(
      mayConfirmIntakeProposal(newSkill, ["intake:confirm", "skill:write", "skill:activate"]),
    ).toBe(true);
    expect(mayConfirmIntakeProposal(newSkill, ["intake:confirm", "knowledge:write"])).toBe(false);
    expect(mayConfirmIntakeProposal(newSkill, ["skill:write", "skill:activate"])).toBe(false);
  });

  test("replacing a skill also needs archive rights", () => {
    const writer = ["intake:confirm", "skill:write", "skill:activate"];
    expect(mayConfirmIntakeProposal(replacingSkill, writer)).toBe(false);
    expect(mayConfirmIntakeProposal(replacingSkill, [...writer, "skill:archive"])).toBe(true);
    expect(mayConfirmIntakeProposal(replacingSkill, [...writer.slice(0, 2), "skill:archive"])).toBe(
      false,
    );
  });

  test("the target line names a new skill's domain or the replaced skill and version", () => {
    if (!("skill" in newSkill) || !("skill" in replacingSkill)) throw new Error("skill target");
    expect(newSkillLine(newSkill, de)).toBe("Neuer Skill „Rollbacks“ · betrieb · gilt überall");
    expect(newSkillLine(newSkill, en)).toBe(
      "New skill “Rollbacks” · betrieb · applies in every context",
    );
    expect(
      newSkillLine(
        {
          skill: {
            new: {
              title: "Paging",
              scope: "connector",
              connector_id: SKILL,
              tags: [],
              category: "betrieb",
            },
            supersedes: [],
          },
        },
        de,
        "Orders API",
      ),
    ).toBe("Neuer Skill „Paging“ · betrieb · nur für Konnektor Orders API");
    expect(newSkillLine(replacingSkill, de)).toBeNull();
    expect(changedSkillLine("replace", { title: "Alte Regel", version: 2 }, undefined, de)).toBe(
      "Ersetzt Alte Regel (v2)",
    );
    expect(changedSkillLine("update", { title: "Regel", version: 5 }, 3, de)).toBe(
      "Ändert Regel (v3)",
    );
    expect(skillTargetIds(replacingSkill)).toEqual([SKILL, OLD]);
  });

  test("a transcript-derived session id is shortened to a readable label", () => {
    expect(sessionLabel(`transcript-${"ab12cd34"}${"0".repeat(24)}`, de)).toBe(
      "Transkript ab12cd34",
    );
    expect(sessionLabel("sess-1", de)).toBe("sess-1");
  });

  test("the change to a replaced skill is a focused line diff", () => {
    expect(skillBodyChange("a\nb", "a\nb")).toEqual([]);
    expect(skillBodyChange("a\nold", "a\nnew")).toEqual([
      { type: "context", text: "a" },
      { type: "removed", text: "old" },
      { type: "added", text: "new" },
    ]);
  });
});

describe("intakeStripState", () => {
  test("names the one state the strip shows", () => {
    expect(intakeStripState({ state: "collected" }, [])).toBe("new");
    expect(intakeStripState({ state: "reviewing" }, [{ status: "draft" }])).toBe("proposal");
    expect(
      intakeStripState({ state: "reviewing" }, [{ status: "draft" }, { status: "stale" }]),
    ).toBe("changed");
    expect(intakeStripState({ state: "admitted" }, [{ status: "draft" }])).toBe("confirmed");
    expect(intakeStripState({ state: "discarded" }, [{ status: "draft" }])).toBe("discarded");
  });
});

describe("intakeEvents", () => {
  const proposal = (status: string, rejected_at: string | null = null) => ({
    id: status,
    status,
    created_at: "2026-10-20T08:00:00.000Z",
    updated_at: "2026-10-21T08:00:00.000Z",
    rejected_at,
    revision: { title: `Vorschlag ${status}` },
  });

  test("lists collection, proposals and decisions newest first", () => {
    const events = intakeEvents(
      {
        state: "discarded",
        created_at: "2026-10-19T08:00:00.000Z",
        updated_at: "2026-10-22T08:00:00.000Z",
      },
      [proposal("confirmed"), proposal("rejected", "2026-10-20T12:00:00.000Z")],
    );
    expect(events.map((event) => event.kind)).toEqual([
      "discarded",
      "confirmed",
      "rejected",
      "proposed",
      "proposed",
      "collected",
    ]);
  });

  test("a changed proposal is recorded once it went stale", () => {
    const events = intakeEvents(
      {
        state: "reviewing",
        created_at: "2026-10-19T08:00:00.000Z",
        updated_at: "2026-10-19T08:00:00.000Z",
      },
      [proposal("stale")],
    );
    expect(events.map((event) => [event.kind, event.title ?? null])).toEqual([
      ["changed", "Vorschlag stale"],
      ["proposed", "Vorschlag stale"],
      ["collected", null],
    ]);
  });
});
