import { describe, expect, test } from "bun:test";
import {
  ageInDays,
  conversationDecision,
  type DecisionItem,
  filterByKinds,
  groupDecisions,
  hasOverdue,
  patchDecision,
  skillDecision,
  sortDecisions,
  splitByAge,
} from "./decisions-model";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW - days * 86_400_000).toISOString();
}

function item(kind: DecisionItem["kind"], days: number, id = `${kind}-${days}`): DecisionItem {
  return {
    kind,
    id,
    title: `${kind} ${days}`,
    target: null,
    waitingSince: daysAgo(days),
    classification: null,
  };
}

describe("decision age", () => {
  test("counts whole days waited", () => {
    expect(ageInDays(daysAgo(18), NOW)).toBe(18);
    expect(ageInDays(daysAgo(0), NOW)).toBe(0);
  });

  test("treats an unparsable timestamp as fresh instead of guessing", () => {
    expect(ageInDays("not-a-date", NOW)).toBe(0);
  });
});

describe("decision ordering", () => {
  test("puts conversation approvals first, then oldest first within a kind", () => {
    const sorted = sortDecisions([
      item("skill", 9),
      item("patch", 1),
      item("patch", 18),
      item("conversation", 0),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual([
      "conversation-0",
      "patch-18",
      "patch-1",
      "skill-9",
    ]);
  });

  test("splits positions older than three days into their own rubric", () => {
    const { current, aged } = splitByAge(
      [item("patch", 2), item("patch", 3), item("patch", 18)],
      NOW,
    );
    expect(current.map((entry) => entry.id)).toEqual(["patch-2"]);
    expect(aged.map((entry) => entry.id)).toEqual(["patch-18", "patch-3"]);
  });

  test("reports overdue only when something crossed the threshold", () => {
    expect(hasOverdue([item("patch", 2)], NOW)).toBe(false);
    expect(hasOverdue([item("patch", 2), item("skill", 4)], NOW)).toBe(true);
  });
});

describe("decision filtering and grouping", () => {
  test("an empty kind filter keeps everything", () => {
    const items = [item("patch", 1), item("skill", 1)];
    expect(filterByKinds(items, [])).toHaveLength(2);
    expect(filterByKinds(items, ["skill"]).map((entry) => entry.kind)).toEqual(["skill"]);
  });

  test("groups by kind and collapses to a single group when off", () => {
    const items = [item("patch", 1), item("skill", 1), item("patch", 2)];
    expect(groupDecisions(items, "none")).toHaveLength(1);
    const byKind = groupDecisions(items, "kind");
    expect(byKind.map((group) => group.key)).toEqual(["patch", "skill"]);
    expect(byKind[0]?.items).toHaveLength(2);
  });
});

describe("decision adapters", () => {
  test("a patch takes its title from the proposal description, never from an id", () => {
    const decision = patchDecision(
      {
        id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "t",
        workflow_id: "w",
        workflow_name: "Daily report",
        classification: "safe",
        status: "proposed",
        fixture_id: null,
        diff: { proposal: { description: "Follow the renamed field" } },
        created_at: daysAgo(18),
        updated_at: daysAgo(18),
      },
      "Proposed fix",
    );
    expect(decision.title).toBe("Follow the renamed field");
    expect(decision.target).toBe("Daily report");
    expect(decision.classification).toBe("safe");
  });

  test("a patch without a readable proposal falls back to a translated label", () => {
    const decision = patchDecision(
      {
        id: "22222222-2222-4222-8222-222222222222",
        tenant_id: "t",
        workflow_id: "w",
        workflow_name: null,
        classification: "unsafe",
        status: "proposed",
        fixture_id: null,
        diff: null,
        created_at: daysAgo(1),
        updated_at: daysAgo(1),
      },
      "Proposed fix",
    );
    expect(decision.title).toBe("Proposed fix");
    expect(decision.target).toBeNull();
  });

  test("a conversation falls back from title to excerpt to a label", () => {
    const base = {
      id: "c1",
      tenant_id: "t",
      target_workflow_id: null,
      target_connector_id: null,
      status: "awaiting_input",
      owner_id: null,
      model: null,
      created_at: daysAgo(1),
      updated_at: daysAgo(1),
    };
    expect(conversationDecision({ ...base, title: "Rename the field" }, "Waiting").title).toBe(
      "Rename the field",
    );
    expect(
      conversationDecision(
        { ...base, title: null, last_message_excerpt: "Shall I apply" },
        "Waiting",
      ).title,
    ).toBe("Shall I apply");
    expect(conversationDecision({ ...base, title: null }, "Waiting").title).toBe("Waiting");
  });

  test("a skill candidate carries its scope as target", () => {
    const decision = skillDecision({
      id: "s1",
      tenant_id: "t",
      scope: "workflow",
      connector_id: null,
      endpoint_key: null,
      workflow_id: null,
      pattern_kind: "repair_pattern",
      title: "Retry on 429",
      body: "",
      examples: [],
      best_practices: [],
      pitfalls: [],
      doc_refs: [],
      evidence_count: 2,
      confidence: "medium",
      status: "proposed",
      promoted_skill_id: null,
      fingerprint: "f",
      version: 1,
      tags: [],
      created_at: daysAgo(4),
      updated_at: daysAgo(4),
    });
    expect(decision.title).toBe("Retry on 429");
    expect(decision.target).toBe("workflow");
  });
});
