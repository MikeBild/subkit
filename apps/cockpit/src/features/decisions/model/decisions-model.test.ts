import { describe, expect, test } from "bun:test";
import { changeRows as coreChangeRows, patchTitle } from "./decision-facts";
import { ageInDays, filterByKinds, sortDecisions, splitByAge } from "./decision-queue";
import {
  conversationDecision,
  hasOverdue,
  patchChangeKind,
  patchDecision,
  QUESTION_LINE_MAX,
  skillDecision,
} from "./decisions-model";
import { daysAgo, item, NOW } from "./decisions-model-fixtures.ts";

test("decision facts core retains precomputed multi-line rows", () => {
  expect(
    coreChangeRows([{ path: "x", inline: null, rows: [{ type: "context", text: "kept" }] }]),
  ).toEqual([{ type: "context", text: "kept" }]);
});

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
    ).toEqual({ proposalKind: "rename_param", driftKind: "schema_diff", fixer: null });
  });

  test("a gate repair carries its rule, its fixer and the environment of the refused run", () => {
    const decision = patchDecision(
      {
        id: "44444444-4444-4444-8444-444444444444",
        tenant_id: "t",
        workflow_id: "w",
        workflow_name: "Monatsreport",
        connector_id: null,
        endpoint_key: "gate:execution_authority_changed",
        classification: "unsafe",
        status: "proposed",
        fixture_id: null,
        diff: {
          workflow_step_id: "compose",
          environment: "prod",
          drift_signal: {
            kind: "gate_block",
            code: "execution_authority_changed",
            reason: "not_utf8",
            fixer: "use_utf8_encoder",
            step_id: "send_email",
          },
          proposal: {
            kind: "gate_fix",
            description: "Encode the report message as UTF-8 in step `compose`",
            reasoning: "The approval gate refused step `send_email`",
          },
        },
        created_at: daysAgo(1),
        updated_at: daysAgo(1),
      } as never,
      "Korrektur für Monatsreport: Nachricht als UTF-8 kodieren",
    );
    expect(decision.summary).toBeNull();
    if (decision.detail.kind !== "patch") throw new Error("not a patch");
    expect(decision.detail.evidence).toMatchObject({
      environment: "prod",
      workflowStepId: "compose",
      gateCode: "execution_authority_changed",
      gateReason: "not_utf8",
      gateStepId: "send_email",
      fixer: "use_utf8_encoder",
    });
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
      facts: null,
      evidence_count: 2,
      confidence: "medium",
      status: "proposed",
      promoted_skill_id: null,
      fingerprint: "f",
      version: 1,
      tags: [],
      proposed_by: null,
      created_at: daysAgo(4),
      updated_at: daysAgo(4),
    });
    expect(decision.title).toBe("Retry on 429");
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
        facts: null,
        evidence_count: 5,
        confidence: "high",
        status: "proposed",
        promoted_skill_id: null,
        fingerprint: "f",
        version: 1,
        tags: [],
        proposed_by: null,
        created_at: daysAgo(4),
        updated_at: daysAgo(4),
      },
      "GA4 Tagesreport",
    );
    expect(decision.target).toBe("GA4 Tagesreport");
    expect(decision.origin).toBe("failurePattern");
  });
});
