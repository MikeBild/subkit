import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { SkillCandidate } from "@/api/decisions";
import { render, renderInRouter } from "@/components/cockpit/patterns/test-utils";
import { SkillCandidatesHeader, SkillCandidatesView } from "./skill-candidates";
import type { CandidateRow, DecisionSummary } from "./skill-candidates-model";

function candidate(id: string, extra: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    id,
    scope: "global",
    pattern_kind: "success_pattern",
    title: `Regel ${id}`,
    body: `Inhalt von ${id}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    reviewable: true,
    review_digest: "d".repeat(64),
    proposed_by: null,
    ...extra,
  } as SkillCandidate;
}

const ROWS: CandidateRow[] = [
  { candidate: candidate("a"), status: "proposed" },
  { candidate: candidate("b"), status: "proposed" },
  { candidate: candidate("c"), status: "approved" },
];

const ADOPTER = ["skill:read", "skill:write", "skill:activate"];

function view({
  permissions = ADOPTER,
  selected = [] as string[],
  summary = null as DecisionSummary | null,
  rows = ROWS,
} = {}) {
  const html = render(
    <SkillCandidatesView
      rows={rows}
      permissions={permissions}
      directory={new Map()}
      selected={new Set(selected)}
      onSelect={() => {}}
      summary={summary}
      deciding={null}
      pending={false}
      failed={false}
      onRetry={() => {}}
      onApprove={() => {}}
      onDiscard={async () => {}}
      onOpen={() => {}}
    />,
  );
  return new JSDOM(html).window.document;
}

const desktop = (document: Document) =>
  document.querySelector('[data-testid="skill-candidates-desktop"]') as Element;

describe("skill candidates", () => {
  test("the page says that collected is not confirmed", async () => {
    const html = await renderInRouter(<SkillCandidatesHeader />);
    expect(html).toContain(
      "Vorschläge aus Läufen und Chats. Erst deine Bestätigung macht daraus einen Skill; gesammelt ist nicht bestätigt.",
    );
  });

  test("rows carry kind, a muted excerpt, source and status", () => {
    const document = view();
    const table = desktop(document);
    const heads = [...table.querySelectorAll("th")].map((head) => head.textContent?.trim());
    expect(heads).toEqual(["", "Kandidat", "Auszug", "Quelle", "Status"]);
    const excerpt = table.querySelector('[data-slot="candidate-excerpt"]');
    expect(excerpt?.textContent).toBe("Inhalt von a");
    expect(excerpt?.className).toContain("bg-muted");
    expect(table.textContent).toContain("Aus einem Lauf, der gut ging");
    expect(table.textContent).toContain("Übernommen");
    expect(document.querySelector('[data-testid="skill-candidates-footnote"]')?.textContent).toBe(
      "Übernehmen veröffentlicht nur die ausgewählten Kandidaten, jeder mit eigenem Audit-Eintrag. Nur angemeldete Personen können übernehmen.",
    );
  });

  test("a decided row can no longer be selected", () => {
    const table = desktop(view());
    const boxes = [...table.querySelectorAll('tbody [role="checkbox"]')];
    expect(boxes.map((box) => box.hasAttribute("disabled"))).toEqual([false, false, true]);
    expect(boxes[0]?.getAttribute("aria-label")).toBe("Regel a auswählen");
    expect(table.querySelector('thead [role="checkbox"]')?.getAttribute("aria-label")).toBe(
      "Alle Kandidaten auswählen",
    );
  });

  test("a selection shows how many are chosen and one filled action", () => {
    const document = view({ selected: ["a", "b"] });
    const bar = document.querySelector('[data-testid="skill-candidates-bulk"]');
    expect(bar?.querySelector('[data-testid="skill-candidates-selected"]')?.textContent).toBe(
      "2 ausgewählt",
    );
    const buttons = [...(bar?.querySelectorAll("button") ?? [])].map((button) => [
      button.textContent?.trim(),
      button.getAttribute("data-variant"),
    ]);
    expect(buttons.map(([label]) => label)).toEqual([
      "Übernehmen",
      "Verwerfen",
      "Auswahl aufheben",
    ]);
    expect(buttons.filter(([, variant]) => variant === "default")).toHaveLength(1);
  });

  test("a decided row in the selection is not counted", () => {
    const document = view({ selected: ["a", "c"] });
    expect(document.querySelector('[data-testid="skill-candidates-selected"]')?.textContent).toBe(
      "1 ausgewählt",
    );
  });

  test("without activation rights a selection may be discarded but not accepted", () => {
    const document = view({ permissions: ["skill:read", "skill:write"], selected: ["a"] });
    expect(document.querySelector('[data-testid="skill-candidates-approve"]')).toBeNull();
    expect(document.querySelector('[data-testid="skill-candidates-discard"]')).not.toBeNull();
  });

  test("readers see the candidates without any selection", () => {
    const document = view({ permissions: ["skill:read"], selected: ["a"] });
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    expect(document.querySelector('[data-testid="skill-candidates-bulk"]')).toBeNull();
  });

  test("after a decision a green status names what was decided", () => {
    const approved = view({ summary: { decision: "approved", decided: ["a", "b"], skipped: 0 } });
    const strip = approved.querySelector('[data-testid="skill-candidates-decided"]');
    expect(strip?.textContent).toBe("2 Kandidaten übernommen.");
    expect(strip?.getAttribute("data-tone")).toBe("ok");
    expect(approved.querySelector('[data-testid="skill-candidates-skipped"]')).toBeNull();
    const rejected = view({ summary: { decision: "rejected", decided: ["a"], skipped: 1 } });
    expect(rejected.querySelector('[data-testid="skill-candidates-decided"]')?.textContent).toBe(
      "1 Kandidat verworfen.",
    );
    expect(
      rejected.querySelector('[data-testid="skill-candidates-skipped"]')?.getAttribute("data-tone"),
    ).toBe("warn");
  });
});
