import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import {
  type ConversationPlaybook,
  type PlaybookEvidence,
  playbookActionTarget,
  playbookEvidenceHref,
  playbookStatusKey,
} from "./chat-playbook";
import { ChatPlaybookPanel, ChatPlaybookSummary } from "./chat-playbook-panel";

const NOW = Date.parse("2030-01-01T12:00:00Z");
const evidence: PlaybookEvidence = {
  id: "evidence",
  kind: "execution",
  label: "Documented execution",
  resource_type: "execution",
  resource_id: "run",
  observed_at: "2030-01-01T11:00:00Z",
  freshness: "fresh",
  href: "/cockpit/?run=run",
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
    expect(html).not.toContain("?run=run");
    expect(html).not.toContain("Geprüft:");
    expect(playbookEvidenceHref(hidden)).toBeNull();
  });

  test("only navigates to local cockpit evidence paths", () => {
    expect(playbookEvidenceHref(evidence)).toBe("/cockpit/?run=run");
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
    const prepared: ConversationPlaybook = {
      ...plan,
      status: "prepared",
      steps: [{ ...plan.steps[0]!, status: "assessment_ready", assurance: "assessment" }],
    };
    expect(render(prepared, "de", true)).toContain("Zur Prüfung vorbereitet");
    expect(render(prepared)).toContain("Einschätzung liegt vor");
    expect(render(prepared)).not.toContain('data-step-status="verified"');
    expect(render(prepared)).not.toContain("Ziel erreicht");
    expect(render(plan)).toContain("Bestätigung durch berechtigte Person erforderlich");
    expect(render(plan)).not.toContain("Durch berechtigte Person bestätigt");
  });
});
