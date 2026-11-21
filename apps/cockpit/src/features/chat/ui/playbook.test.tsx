import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import {
  type ConversationPlaybook,
  type PlaybookEvidence,
  playbookActionTarget,
  playbookAnchorIndex,
  playbookEvidenceHref,
  playbookPanelNextAction,
  playbookStatusKey,
  playbookSummaryVisible,
} from "../model/playbook";
import { ChatPlaybookPanel, ChatPlaybookSummary } from "./playbook-panel";

const NOW = Date.parse("2030-01-01T12:00:00Z");
const evidence: PlaybookEvidence = {
  id: "evidence",
  kind: "execution",
  label: "Documented execution",
  resource_type: "execution",
  resource_id: "run",
  observed_at: "2030-01-01T11:00:00Z",
  freshness: "fresh",
  href: "/cockpit/runs/run",
};
const action = { label: "Review the destination", owner: null, elicitation_id: "question" };
const plan: ConversationPlaybook = {
  id: "playbook",
  title: "Prepare review",
  goal: "A person reviews the proposed content",
  revision: 2,
  status: "waiting_for_input",
  summary: "The proposal exists. Admission is still open.",
  steps: [
    {
      id: "review",
      label: "Review content",
      criterion: "An authorized person confirms the content",
      depends_on: [],
      status: "waiting_for_input",
      reason: "The proposal has not been approved.",
      assurance: "human",
      evidence: [evidence],
      next_action: action,
    },
  ],
  next_action: action,
  completion: {
    status: "open",
    label: "Content admitted after review",
    reason: "No admission has occurred.",
  },
  updated_at: "2030-01-01T11:00:00Z",
};

function render(playbook: ConversationPlaybook, locale: Locale = "de", summary = false) {
  const value: I18nValue = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  };
  const props = { playbook, actionTarget: () => null, onOpenQuestion() {} };
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      {summary ? (
        <ChatPlaybookSummary {...props} onShowDetails={() => {}} />
      ) : (
        <ChatPlaybookPanel {...props} />
      )}
    </I18nContext.Provider>,
  );
}

describe("playbook presentation boundaries", () => {
  test("does not present completion when the required criterion remains open", () => {
    expect(playbookStatusKey({ ...plan, status: "completed" })).toBe("chat.playbook.status.open");
    const html = render({ ...plan, status: "completed" }, "de", true);
    expect(html).not.toContain("Ziel erreicht");
    expect(html).toContain("Offen");
    expect(
      playbookStatusKey({
        ...plan,
        status: "completed",
        completion: { ...plan.completion, status: "verified" },
      }),
    ).toBe("chat.playbook.status.completed");
  });

  test("shows source changes as requiring a new check without a completed step icon", () => {
    const html = render({
      ...plan,
      steps: [
        { ...plan.steps[0]!, status: "stale", evidence: [{ ...evidence, freshness: "stale" }] },
      ],
    });
    expect(html).toContain("Erneut prüfen");
    expect(html).toContain("Beleg muss erneut geprüft werden");
    expect(html).not.toContain('data-step-status="verified"');
  });

  test("removes inaccessible evidence labels, links and observation timestamps", () => {
    const hidden = {
      ...evidence,
      label: "Private source title",
      freshness: "unavailable" as const,
    };
    const html = render({ ...plan, steps: [{ ...plan.steps[0]!, evidence: [hidden] }] });
    expect(html).toContain("Beleg nicht verfügbar");
    expect(html).not.toContain("Private source title");
    expect(html).not.toContain("/runs/run");
    expect(html).not.toContain("Geprüft:");
    expect(playbookEvidenceHref(hidden)).toBeNull();
  });

  test("only navigates to local cockpit evidence paths", () => {
    expect(playbookEvidenceHref(evidence)).toBe("/cockpit/runs/run");
    for (const href of [
      "javascript:alert(1)",
      "https://outside.example/source",
      "//outside.example",
      "/cockpit/../logout",
      "/cockpit/%2e%2e/logout",
      "/cockpit/\\outside",
      "/cockpit/%5coutside",
      "/cockpit/%00source",
      "/cockpit/%",
    ]) {
      expect(playbookEvidenceHref({ ...evidence, href }), href).toBeNull();
    }
  });

  test("a proposed next action cannot create or revive a human decision", () => {
    const questions = [{ id: "question", expiresAt: "2030-01-01T12:10:00Z" }];
    expect(playbookActionTarget(action, questions, NOW)).toBe("question");
    expect(playbookActionTarget(action, [], NOW)).toBeNull();
    expect(playbookActionTarget({ ...action, elicitation_id: "other" }, questions, NOW)).toBeNull();
    expect(playbookActionTarget(action, questions, NOW + 600_000)).toBeNull();
    expect(
      playbookActionTarget(action, [{ id: "question", expiresAt: "invalid" }], NOW),
    ).toBeNull();
    expect(render(plan)).not.toContain("Offene Rückfrage öffnen");
  });

  test("keeps criterion and responsibility visible without inventing an owner", () => {
    const html = render(plan);
    expect(html).toContain(plan.completion.label);
    expect(html).toContain(plan.completion.reason);
    expect(html).toContain("Zuständigkeit noch zu klären");
    expect(html).toContain('data-revision="2"');
    expect(html).not.toContain("Freigeben");
  });

  test("assessments are labelled as assessments in both supported languages", () => {
    const assessment = {
      ...plan,
      steps: [{ ...plan.steps[0]!, assurance: "assessment" as const }],
    };
    expect(render(assessment)).toContain("Einschätzung; kein unabhängiger Nachweis");
    expect(render(assessment, "en")).toContain("Assessment; not independent verification");
  });

  test("a delivered assessment is useful preparation without claiming technical success", () => {
    const assessed: ConversationPlaybook = {
      ...plan,
      status: "in_progress",
      next_action: null,
      steps: [
        {
          ...plan.steps[0]!,
          status: "assessment_ready",
          assurance: "assessment",
          evidence: [],
          next_action: null,
        },
      ],
    };
    const card = render(assessed, "de", true);
    const panel = render(assessed);
    expect(card).toContain("In Bearbeitung");
    expect(card).not.toContain("Zur Prüfung vorbereitet");
    expect(panel).not.toContain("Zur Prüfung vorbereitet");
    expect(panel).toContain("Einschätzung liegt vor");
    expect(panel).not.toContain('data-step-status="verified"');
    expect(panel).not.toContain("Ziel erreicht");
    expect(panel).not.toContain("Offene Rückfrage öffnen");
    expect(playbookActionTarget(assessed.next_action, [], NOW)).toBeNull();
    expect(render(plan)).toContain("Bestätigung durch berechtigte Person erforderlich");
    expect(render(plan)).not.toContain("Durch berechtigte Person bestätigt");
  });

  test("places the playbook after the reply of the turn that last changed it", () => {
    const messages = [
      { role: "user", created_at: "2030-01-01T03:20:30Z" },
      { role: "assistant", created_at: "2030-01-01T03:20:54Z" },
      { role: "user", created_at: "2030-01-01T03:21:35Z" },
      { role: "assistant", created_at: "2030-01-01T03:21:39Z" },
    ];
    expect(playbookAnchorIndex(messages, { updated_at: "2030-01-01T03:20:49Z" })).toBe(1);
    expect(playbookAnchorIndex(messages, { updated_at: "2030-01-01T03:21:36Z" })).toBe(3);
    expect(playbookAnchorIndex(messages, { updated_at: "invalid" })).toBeNull();
    expect(playbookAnchorIndex(messages.slice(0, 1), { updated_at: "2030-01-01T03:20:49Z" })).toBe(
      0,
    );
  });

  test("places the playbook after the final reply of the turn whose call wrote the revision", () => {
    const messages = [
      { id: "u1", role: "user", created_at: "2030-01-01T03:20:30Z" },
      { id: "a1", role: "assistant", created_at: "2030-01-01T03:20:40Z" },
      { id: "a2", role: "assistant", created_at: "2030-01-01T03:20:54Z" },
      { id: "u2", role: "user", created_at: "2030-01-01T03:21:35Z" },
      { id: "a3", role: "assistant", created_at: "2030-01-01T03:21:39Z" },
    ];
    const revision = {
      tool: "update_playbook",
      created_at: "2030-01-01T03:20:38Z",
      parent_message_id: "a1",
      outcome: "ok",
    };
    const decided = { updated_at: "2030-01-01T03:21:37Z" };
    expect(playbookAnchorIndex(messages, decided, [revision])).toBe(2);
    expect(playbookAnchorIndex(messages, decided, [{ ...revision, parent_message_id: null }])).toBe(
      2,
    );
    expect(
      playbookAnchorIndex(messages, decided, [
        revision,
        {
          ...revision,
          created_at: "2030-01-01T03:21:38Z",
          parent_message_id: "a3",
          outcome: "error",
        },
      ]),
    ).toBe(2);
    expect(playbookAnchorIndex(messages, { updated_at: "2030-01-01T03:20:45Z" })).toBe(2);
    expect(playbookAnchorIndex(messages, decided)).toBe(4);
  });

  test("shows the playbook summary in the chat only while the panel is closed", () => {
    expect(playbookSummaryVisible(true)).toBe(false);
    expect(playbookSummaryVisible(false)).toBe(true);
  });

  test("the panel shows a next step that belongs to a step only once", () => {
    const decision = {
      label: "Gewünschte Betriebsumgebung fachlich festlegen",
      owner: "Betreiber",
      elicitation_id: null,
    };
    const repeated: ConversationPlaybook = {
      ...plan,
      next_action: decision,
      steps: [{ ...plan.steps[0]!, next_action: decision }],
    };
    expect(playbookPanelNextAction(repeated)).toBeNull();
    expect(render(repeated).split(decision.label).length - 1).toBe(1);
    const separate = { ...repeated, next_action: { ...decision, label: "Ergebnis prüfen" } };
    expect(playbookPanelNextAction(separate)?.label).toBe("Ergebnis prüfen");
  });
});
