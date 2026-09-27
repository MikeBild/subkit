import { describe, expect, test } from "bun:test";
import {
  ageInDays,
  approveBlockedReason,
  badgeCount,
  bannerSubset,
  conversationDecision,
  countOpenDecisions,
  type DecisionItem,
  filterByKinds,
  hasOverdue,
  humanStep,
  openDecisionQueue,
  partitionByUrgency,
  patchChangeKind,
  patchDecision,
  patchTitle,
  QUESTION_LINE_MAX,
  queueChips,
  queueDisplayState,
  resetView,
  searchWithoutBucket,
  skillDecision,
  sortDecisions,
  splitByAge,
  suggestionTargets,
} from "./decisions-model";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW - days * 86_400_000).toISOString();
}

function item(
  kind: DecisionItem["kind"],
  days: number,
  id = `${kind}-${days}`,
  overrides: Partial<DecisionItem> = {},
): DecisionItem {
  return {
    kind,
    id,
    title: `${kind} ${days}`,
    target: null,
    origin: kind === "conversation" ? "conversation" : "observedFailure",
    waitingSince: daysAgo(days),
    classification: null,
    expiresAt: null,
    confidence: null,
    evidenceCount: null,
    summary: null,
    detail: { kind: "patch", evidence: PATCH_EVIDENCE },
    ...overrides,
  };
}

/** A patch candidate carrying nothing — the shape a fixture needs so the model
 *  under test is exercised, not the fixture's own optional fields. */
const PATCH_EVIDENCE = {
  workflowId: null,
  workflowName: null,
  connectorId: null,
  endpointKey: null,
  executionId: null,
  driftKind: null,
  driftSummary: null,
  reasoning: null,
  proposalKind: null,
  classificationReasons: [],
  rejections: [],
};

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

describe("decision filtering", () => {
  test("an empty kind filter keeps everything", () => {
    const items = [item("patch", 1), item("skill", 1)];
    expect(filterByKinds(items, [])).toHaveLength(2);
    expect(filterByKinds(items, ["skill"]).map((entry) => entry.kind)).toEqual(["skill"]);
  });
});

describe("decision adapters", () => {
  test("a patch keeps the engine's own change note as its summary, not as its title", () => {
    const decision = patchDecision(
      {
        id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "t",
        workflow_id: "w",
        workflow_name: "Daily report",
        connector_id: null,
        endpoint_key: null,
        classification: "safe",
        status: "proposed",
        fixture_id: null,
        diff: {
          proposal: { kind: "update_field_path", description: "Follow the renamed field" },
        },
        closed_reason: null,
        closed_against_version_id: null,
        closed_at: null,
        created_at: daysAgo(18),
        updated_at: daysAgo(18),
      },
      "Korrektur für Daily report: Folgt einem verschobenen Feld",
    );
    expect(decision.title).toBe("Korrektur für Daily report: Folgt einem verschobenen Feld");
    // The English change note is the DETAIL, and it is still carried.
    expect(decision.summary).toBe("Follow the renamed field");
    expect(decision.target).toBe("Daily report");
    expect(decision.classification).toBe("safe");
  });

  test("a patch names the kinds the title is composed from", () => {
    expect(
      patchChangeKind({
        id: "3",
        tenant_id: "t",
        workflow_id: "w",
        workflow_name: null,
        connector_id: null,
        endpoint_key: null,
        classification: "safe",
        status: "proposed",
        fixture_id: null,
        diff: { proposal: { kind: "rename_param" }, drift_signal: { kind: "schema_diff" } },
        created_at: daysAgo(1),
        updated_at: daysAgo(1),
      } as never),
    ).toEqual({ proposalKind: "rename_param", driftKind: "schema_diff" });
  });

  describe("patchTitle", () => {
    test("names the workflow and what the change does", () => {
      expect(patchTitle({ workflow: "Monatsreport", change: "Folgt einem Feld" })).toEqual({
        key: "decisions.patchTitle",
        params: { workflow: "Monatsreport", change: "Folgt einem Feld" },
      });
    });

    test("drops the half it does not have rather than inventing it", () => {
      expect(patchTitle({ workflow: "Monatsreport", change: null }).key).toBe(
        "decisions.patchTitleWorkflow",
      );
      expect(patchTitle({ workflow: null, change: "Ergänzt einen Header" }).key).toBe(
        "decisions.patchTitleChange",
      );
      expect(patchTitle({ workflow: "  ", change: "  " }).key).toBe(
        "decisions.fallbackTitle.patch",
      );
    });
  });

  test("a patch without a readable proposal falls back to a translated label", () => {
    const decision = patchDecision(
      {
        id: "22222222-2222-4222-8222-222222222222",
        tenant_id: "t",
        workflow_id: "w",
        workflow_name: null,
        connector_id: null,
        endpoint_key: null,
        classification: "unsafe",
        status: "proposed",
        fixture_id: null,
        diff: null,
        closed_reason: null,
        closed_against_version_id: null,
        closed_at: null,
        created_at: daysAgo(1),
        updated_at: daysAgo(1),
      },
      "Vorgeschlagene Korrektur",
    );
    expect(decision.title).toBe("Vorgeschlagene Korrektur");
    expect(decision.target).toBeNull();
  });

  const LABELS = {
    fallbackTitle: "Waiting",
    toolActivity: "Governed action completed",
    hiddenReference: "internal reference",
  };
  const conversationBase = {
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

  test("a conversation falls back from title to excerpt to a label", () => {
    expect(
      conversationDecision({ ...conversationBase, title: "Rename the field" }, LABELS).title,
    ).toBe("Rename the field");
    expect(
      conversationDecision(
        { ...conversationBase, title: null, last_message_excerpt: "Shall I apply" },
        LABELS,
      ).title,
    ).toBe("Shall I apply");
    expect(conversationDecision({ ...conversationBase, title: null }, LABELS).title).toBe(
      "Waiting",
    );
  });

  test("a raw tool excerpt never becomes a title carrying an identifier", () => {
    const decision = conversationDecision(
      {
        ...conversationBase,
        title: null,
        last_message_excerpt:
          '{"tool":"run_workflow","output":{"status":"awaiting_input","elicitation_id":"7b7f5376-5127-413e-aaec-bc79f14ef8e5"}}',
      },
      LABELS,
    );
    expect(decision.title).toBe("Governed action completed");
    expect(decision.title).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
  });

  test("an identifier inside prose is redacted rather than shown", () => {
    const decision = conversationDecision(
      {
        ...conversationBase,
        title: null,
        last_message_excerpt:
          "**ContentKit Editorial MCP PROD** ist gespeichert und live. - Connector-ID: `2f65bdfb-0e86-4d70-b197-048062ca94ce` (prod)",
      },
      LABELS,
    );
    expect(decision.title).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
    expect(decision.title).toContain("internal reference");
  });

  test("the collapsed line clips the question, the panel keeps it whole", () => {
    // The reason the engine stopped clipping: if both came from one excerpt,
    // expanding a card showed exactly what the collapsed line already showed.
    // Squashed and trimmed, the way the engine sends it.
    const question =
      `Should I overwrite the existing schedule? ${"Here is the reasoning. ".repeat(20)}`.trim();
    const decision = conversationDecision(
      {
        ...conversationBase,
        title: "Rename the field",
        pending_elicitation_summary: question,
        pending_elicitation_tool: null,
      },
      LABELS,
    );
    const summary = decision.summary as string;
    expect(summary.length).toBeLessThanOrEqual(QUESTION_LINE_MAX);
    expect(summary.endsWith("…")).toBe(true);
    // Cut at a word boundary: what survives is a prefix of the question that
    // the original continues with a space, not half of a word.
    const kept = summary.slice(0, -1);
    expect(question.startsWith(`${kept} `)).toBe(true);
    if (decision.detail.kind !== "conversation") throw new Error("expected a conversation detail");
    expect(decision.detail.question).toBe(question);
    expect((decision.detail.question as string).length).toBeGreaterThan(summary.length);
  });

  test("a short question is not clipped and reaches both places intact", () => {
    const question = "Should I overwrite the existing schedule?";
    const decision = conversationDecision(
      {
        ...conversationBase,
        title: "Rename the field",
        pending_elicitation_summary: question,
        pending_elicitation_tool: null,
      },
      LABELS,
    );
    expect(decision.summary).toBe(question);
    if (decision.detail.kind !== "conversation") throw new Error("expected a conversation detail");
    expect(decision.detail.question).toBe(question);
  });

  test("an identifier in the question is hidden in the line AND in the panel", () => {
    // The clip runs after the redaction, so a long question cannot smuggle an
    // id past it by sitting beyond the cut.
    const question = `Load the v6 workflow c1d9b3db-882e-4f2c-8fd0-5f0017c4aef1 as the draft target? ${"Context follows. ".repeat(20)}`;
    const decision = conversationDecision(
      {
        ...conversationBase,
        title: "Rename the field",
        pending_elicitation_summary: question,
        pending_elicitation_tool: null,
      },
      LABELS,
    );
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
    expect(decision.summary).not.toMatch(uuid);
    if (decision.detail.kind !== "conversation") throw new Error("expected a conversation detail");
    expect(decision.detail.question).not.toMatch(uuid);
    expect(decision.detail.question).toContain("internal reference");
  });

  test("a skill candidate names its target, and says nothing when it cannot", () => {
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
    // The scope word used to be rendered as the target, so a card scoped to a
    // workflow said the literal string "workflow" where a person expected the
    // name of one. Nothing beats a wrong name.
    expect(decision.target).toBeNull();
    expect(decision.origin).toBe("repairPattern");
    expect(decision.confidence).toBe("medium");
    expect(decision.evidenceCount).toBe(2);
  });

  test("a resolved name reaches the card as the target", () => {
    const decision = skillDecision(
      {
        id: "s2",
        tenant_id: "t",
        scope: "workflow",
        connector_id: null,
        endpoint_key: null,
        workflow_id: "wf-1",
        pattern_kind: "failure_pattern",
        title: "Retry on 429",
        body: "",
        examples: [],
        best_practices: [],
        pitfalls: [],
        doc_refs: [],
        evidence_count: 5,
        confidence: "high",
        status: "proposed",
        promoted_skill_id: null,
        fingerprint: "f",
        version: 1,
        tags: [],
        created_at: daysAgo(4),
        updated_at: daysAgo(4),
      },
      "GA4 Tagesreport",
    );
    expect(decision.target).toBe("GA4 Tagesreport");
    expect(decision.origin).toBe("failurePattern");
  });
});

describe("urgency", () => {
  test("a stopped conversation outranks an older proposal nothing waits on", () => {
    // Age alone put the thing nobody is waiting on above the thing that is
    // stopped dead — this is the split that fixes that.
    const rubrics = partitionByUrgency(
      [item("patch", 9, "old-patch"), item("conversation", 0, "fresh-talk")],
      NOW,
    );
    expect(rubrics.blocking.map((entry) => entry.id)).toEqual(["fresh-talk"]);
    expect(rubrics.deferred.aged.map((entry) => entry.id)).toEqual(["old-patch"]);
  });

  test("a lapsed deadline moves a position out of the working queue entirely", () => {
    const expired = item("conversation", 1, "gone", {
      expiresAt: new Date(NOW - 60_000).toISOString(),
    });
    const rubrics = partitionByUrgency([expired], NOW);
    expect(rubrics.expired.map((entry) => entry.id)).toEqual(["gone"]);
    expect(rubrics.blocking).toEqual([]);
  });

  test("the nearest deadline sorts first, ahead of the oldest position", () => {
    const soon = item("conversation", 0, "soon", {
      expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
    });
    const later = item("conversation", 5, "later", {
      expiresAt: new Date(NOW + 20 * 60 * 60_000).toISOString(),
    });
    expect(sortDecisions([later, soon]).map((entry) => entry.id)).toEqual(["soon", "later"]);
  });

  test("a deadline inside a day counts as urgent even though nothing lapsed yet", () => {
    const soon = item("conversation", 0, "soon", {
      expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
    });
    expect(hasOverdue([soon], NOW)).toBe(true);
  });

  test("an unreadable deadline is treated as no deadline, not as expired", () => {
    const broken = item("conversation", 0, "broken", { expiresAt: "not a date" });
    const rubrics = partitionByUrgency([broken], NOW);
    expect(rubrics.expired).toEqual([]);
    expect(rubrics.blocking.map((entry) => entry.id)).toEqual(["broken"]);
  });
});

describe("countOpenDecisions", () => {
  const totals = { patch: 3, skill: 1, conversation: 2 };

  test("the total is the sum of the engine's own counts, not the rows in hand", () => {
    // Every source is fetched with a page cap. Counting the rows would
    // under-report a backlog by exactly the amount that matters.
    const open = countOpenDecisions({
      items: [item("patch", 1)],
      totals: { patch: 118, skill: 0, conversation: 1 },
      nowMs: NOW,
    });
    expect(open.total).toBe(118);
    expect(open.byKind).toEqual({ patch: 118, skill: 0, conversation: 1 });
    expect(open.capped).toBe(true);
  });

  test("a position delivered twice is one decision", () => {
    const twice = item("patch", 4, "same-row");
    const open = countOpenDecisions({
      items: [twice, { ...twice, title: "another rendering of the same row" }, item("skill", 1)],
      totals: { patch: 1, skill: 1, conversation: 0 },
      nowMs: NOW,
    });
    expect(open.total).toBe(2);
    expect(open.capped).toBe(false);
    expect(open.subsets.aging).toBe(1);
  });

  test("splits the queue into what stops you, what lapsed and what merely sat", () => {
    const open = countOpenDecisions({
      items: [
        item("conversation", 0, "stopped"),
        item("conversation", 1, "lapsed", {
          expiresAt: new Date(NOW - 3_600_000).toISOString(),
        }),
        item("patch", 19, "old"),
        item("patch", 1, "fresh"),
        item("skill", 4, "older"),
      ],
      totals: { patch: 2, skill: 1, conversation: 2 },
      nowMs: NOW,
    });
    expect(open.subsets).toEqual({ blocking: 1, overdue: 1, aging: 2 });
    expect(open.oldestAgeDays).toBe(19);
  });

  test("without engine totals it counts approvals separately from questions", () => {
    const open = countOpenDecisions({
      items: [item("patch", 1), item("conversation", 2)],
      totals: null,
      nowMs: NOW,
    });
    expect(open.total).toBe(1);
    expect(open.byKind).toEqual({ patch: 1, skill: 0, conversation: 1 });
    expect(open.capped).toBe(false);
  });

  test("an empty queue counts to zero across every field", () => {
    const open = countOpenDecisions({ items: [], totals: null, nowMs: NOW });
    expect(open.total).toBe(0);
    expect(open.subsets).toEqual({ blocking: 0, overdue: 0, aging: 0 });
    expect(open.oldestAgeDays).toBe(0);
    expect(bannerSubset(open).shown).toBe(false);
  });

  test("byKind always carries all three sources, including the silent ones", () => {
    const open = countOpenDecisions({ items: [], totals, nowMs: NOW });
    expect(Object.keys(open.byKind).sort()).toEqual(["conversation", "patch", "skill"]);
  });
});

describe("bannerSubset", () => {
  function open(overrides: {
    total: number;
    blocking?: number;
    overdue?: number;
    aging?: number;
    capped?: boolean;
  }) {
    return {
      total: overrides.total,
      decidable: 0,
      // The banner's base is the CONVERSATIONS, not the whole page: both states
      // it may claim — stopped right now, deadline lapsed — belong to a waiting
      // conversation and to nothing else. `total` here is therefore the
      // conversation count, which is what the banner states its shares of.
      byKind: { patch: 0, skill: 0, conversation: overrides.total },
      subsets: {
        blocking: overrides.blocking ?? 0,
        overdue: overrides.overdue ?? 0,
        aging: overrides.aging ?? 0,
      },
      oldestAgeDays: 0,
      capped: overrides.capped ?? false,
    };
  }

  test("names each share of the whole rather than one number standing alone", () => {
    expect(bannerSubset(open({ total: 30, blocking: 25, overdue: 2 }))).toEqual({
      blocking: 25,
      overdue: 2,
      count: 27,
      total: 30,
      atLeast: false,
      shown: true,
    });
  });

  test("never claims a position the queue files as blocking nothing", () => {
    // The aged rubric sits under a heading that says it blocks nothing. A red
    // banner counting it as something that does is the product contradicting
    // itself one click away, which is exactly what this used to do.
    const banner = bannerSubset(open({ total: 8, blocking: 1, overdue: 1, aging: 3 }));
    expect(banner.count).toBe(2);
    expect(banner.blocking + banner.overdue).toBe(banner.count);
  });

  test("aging alone raises no banner at all", () => {
    expect(bannerSubset(open({ total: 12, aging: 9 })).shown).toBe(false);
  });

  test("keeps the two apart, because no one verb is true of both", () => {
    const lapsed = bannerSubset(open({ total: 4, overdue: 4 }));
    expect(lapsed.blocking).toBe(0);
    expect(lapsed.overdue).toBe(4);
    expect(lapsed.shown).toBe(true);
  });

  test("a capped page can only claim a floor", () => {
    const banner = bannerSubset(open({ total: 119, blocking: 5, capped: true }));
    expect(banner.atLeast).toBe(true);
    expect(banner.count).toBe(5);
    expect(banner.total).toBe(119);
  });

  test("a capped page with nothing urgent claims nothing at all", () => {
    const banner = bannerSubset(open({ total: 119, aging: 40, capped: true }));
    expect(banner.shown).toBe(false);
    expect(banner.atLeast).toBe(false);
  });

  test("an empty queue shows no banner", () => {
    expect(bannerSubset(open({ total: 0 })).shown).toBe(false);
  });
});

describe("queueDisplayState", () => {
  const base = { shown: 0, held: 0, failing: 0, total: 0, narrowed: false };

  test("anything on screen means rows — whichever section it is in", () => {
    // The bug the product owner saw: a failing workflow rendered beside "all
    // done". Each section alone has to count as content.
    expect(queueDisplayState({ ...base, failing: 1, total: 1 })).toBe("rows");
    expect(queueDisplayState({ ...base, held: 1, total: 1 })).toBe("rows");
    expect(queueDisplayState({ ...base, shown: 1, total: 1 })).toBe("rows");
  });

  test("nothing at all is the only empty queue", () => {
    expect(queueDisplayState(base)).toBe("empty");
  });

  test("narrowed away is not the same as nothing waiting", () => {
    // Telling somebody "nothing is waiting" when their own filter hid it is
    // the same lie as the one above, from the other direction.
    expect(queueDisplayState({ ...base, narrowed: true, total: 4 })).toBe("filtered-empty");
    // Narrowed, but there was never anything: then it really is empty.
    expect(queueDisplayState({ ...base, narrowed: true, total: 0 })).toBe("empty");
  });
});

describe("the badge counts what the chips count", () => {
  // A queue with every kind in it, including what the badge must NOT count:
  // two waiting conversations and one proposal nobody can decide.
  const items = [
    item("patch", 1, "p1", { reviewable: true }),
    item("patch", 5, "p2", { reviewable: true }),
    item("patch", 2, "p3", { reviewable: false }),
    item("skill", 1, "s1", { reviewable: true }),
    item("conversation", 0, "c1"),
    item("conversation", 0, "c2"),
  ];
  const totals = { patch: 2, skill: 1, conversation: 2 };

  const everything = { patches: true, skills: true, failing: true };
  const shown = (chips: ReturnType<typeof queueChips>) =>
    (chips ?? []).map((chip) => [chip.kind, chip.count, chip.partial]);
  const sum = (chips: ReturnType<typeof queueChips>) =>
    (chips ?? []).reduce((total, chip) => total + (chip.count ?? 0), 0);

  test("badge equals the sum of the chips", () => {
    const open = openDecisionQueue({ items, totals, held: 1, failing: 2, nowMs: NOW });
    const chips = queueChips({
      open,
      readable: everything,
      held: 1,
      failing: { state: "answered", count: 2 },
    });
    expect(shown(chips)).toEqual([
      ["patch", 2, false],
      ["skill", 1, false],
      ["schedule", 3, false],
    ]);
    expect(badgeCount(chips)).toBe(sum(chips));
    expect(open.total).toBe(sum(chips));
    expect(open.total).toBe(6);
  });

  test("a source this person cannot read has no chip, never a chip at 0", () => {
    // Without skill:read the skill chip read "· 0" — a number nobody measured.
    const open = openDecisionQueue({
      items: items.filter((entry) => entry.kind !== "skill"),
      totals: { patch: 2, skill: 0, conversation: 2 },
      held: 1,
      failing: 0,
      nowMs: NOW,
    });
    const chips = queueChips({
      open,
      readable: { patches: true, skills: false, failing: false },
      held: 1,
      failing: { state: "not_permitted", count: 0 },
    });
    expect(chips?.map((chip) => chip.kind)).toEqual(["patch", "schedule"]);
    // The index stays the position in the full list, so ids do not shift.
    expect(chips?.map((chip) => chip.index)).toEqual([0, 2]);
    expect(badgeCount(chips)).toBe(sum(chips));
    // Without workflow:read neither the patch chip nor the held half is there.
    const noWorkflows = queueChips({
      open,
      readable: { patches: false, skills: true, failing: true },
      held: 0,
      failing: { state: "answered", count: 2 },
    });
    expect(noWorkflows?.map((chip) => chip.kind)).toEqual(["skill", "schedule"]);
  });

  test("a source that failed is never counted as 0", () => {
    // The digest failed and used to be caught as an empty list: "none failing".
    const open = openDecisionQueue({ items, totals, held: 1, failing: 0, nowMs: NOW });
    const partial = queueChips({
      open,
      readable: everything,
      held: 1,
      failing: { state: "failed", count: 0 },
    });
    const schedule = partial?.find((chip) => chip.kind === "schedule");
    // What answered is shown, as a lower bound, and the badge counts only it.
    expect(schedule).toMatchObject({ count: 1, partial: true });
    expect(badgeCount(partial)).toBe(sum(partial));

    // With no other source behind the chip, it has no number at all.
    const alone = queueChips({
      open: openDecisionQueue({ items: [], totals: null, held: 0, failing: 0, nowMs: NOW }),
      readable: { patches: false, skills: false, failing: true },
      held: 0,
      failing: { state: "failed", count: 0 },
    });
    expect(shown(alone)).toEqual([["schedule", null, false]]);
    // And the badge does not claim 0 over it.
    expect(badgeCount(alone)).toBeNull();
  });

  test("the waiting conversations are counted on their own, never in the badge", () => {
    const open = openDecisionQueue({ items, totals, held: 0, failing: 0, nowMs: NOW });
    expect(open.byKind.conversation).toBe(2);
    expect(open.total).toBe(3);
  });

  test("no count read, no chip numbers — an omitted number beats a guessed one", () => {
    const chips = queueChips({
      open: null,
      readable: everything,
      held: 4,
      failing: { state: "answered", count: 0 },
    });
    expect(chips).toBeNull();
    expect(badgeCount(chips)).toBeNull();
  });
});

describe("one way back to the whole queue", () => {
  test("reset clears the tile's focus AND the chips", () => {
    expect(resetView()).toEqual({ focus: null, kinds: [] });
  });

  test("after a reset, a queue with anything in it is never 'nothing matches'", () => {
    // The dead end: from the Blocked tile with no blocked workflow, "Alle
    // anzeigen" cleared only the chips, and the list stayed narrowed and empty.
    const view = resetView();
    const narrowed = view.focus !== null || view.kinds.length > 0;
    expect(queueDisplayState({ shown: 3, held: 0, failing: 0, total: 3, narrowed })).toBe("rows");
    expect(narrowed).toBe(false);
  });

  test("the address loses the tile's bucket and keeps everything else", () => {
    expect(searchWithoutBucket("?bucket=blocked")).toBe("");
    expect(searchWithoutBucket("?bucket=failing&workflow_id=w1")).toBe("?workflow_id=w1");
    expect(searchWithoutBucket("")).toBe("");
  });
});

describe("why Freigeben cannot be pressed", () => {
  const base = {
    canDecide: true,
    expanded: true,
    kind: "patch" as const,
    reviewDigest: null,
    preview: { reviewable: true, review_digest: "d" },
  };

  test("a role that may not decide is told so first", () => {
    expect(approveBlockedReason({ ...base, canDecide: false, expanded: false })).toBe(
      "decisions.approveNeedsRole",
    );
  });

  test("an unopened change asks to be looked at first", () => {
    expect(approveBlockedReason({ ...base, expanded: false })).toBe("decisions.approveNeedsReview");
  });

  test("a change the engine will not take says so", () => {
    expect(approveBlockedReason({ ...base, preview: { reviewable: false } })).toBe(
      "decisions.approveNotReviewable",
    );
    expect(
      approveBlockedReason({ ...base, kind: "skill", preview: undefined, reviewDigest: null }),
    ).toBe("decisions.approveNotReviewable");
  });

  test("nothing blocking, or a preview still loading, gives no reason", () => {
    expect(approveBlockedReason(base)).toBeNull();
    expect(approveBlockedReason({ ...base, preview: undefined })).toBeNull();
    expect(approveBlockedReason({ ...base, kind: "skill", reviewDigest: "d" })).toBeNull();
  });
});

describe("suggestions lead somewhere or are not shown", () => {
  test("an undecidable proposal with a workflow links to it; one without is left out", () => {
    const withWorkflow = item("patch", 1, "p1", {
      reviewable: false,
      detail: { kind: "patch", evidence: { ...PATCH_EVIDENCE, workflowId: "w1" } },
    });
    const without = item("patch", 1, "p2", { reviewable: false });
    const decidable = item("patch", 1, "p3", {
      reviewable: true,
      detail: { kind: "patch", evidence: { ...PATCH_EVIDENCE, workflowId: "w2" } },
    });
    const conversation = item("conversation", 0, "c1");
    expect(
      suggestionTargets([withWorkflow, without, decidable, conversation]).map((entry) => [
        entry.item.id,
        entry.workflowId,
      ]),
    ).toEqual([["p1", "w1"]]);
  });
});

describe("a step key as a person reads it", () => {
  test("underscores and hyphens become spaces", () => {
    expect(humanStep("fetch_orders")).toBe("fetch orders");
    expect(humanStep("send--report_mail")).toBe("send report mail");
  });
});
