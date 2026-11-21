import { describe, expect, test } from "bun:test";
import { UiProvider } from "@ui/lib/ui-context";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { ApprovalLimitsFields } from "./approval-limits";
import { type KpiCard, NeedRow, NeedsAllClear, OverviewKpis, RunRow } from "./Overview";
import { PairApprovalCard, PairLinkNotice } from "./PairApproval";
import { pairLinkTarget } from "./pair-link-model";
import { RunResultDocument } from "./RunResult";
import { CurrentApprovalBody, WorkflowStepsPanel } from "./WorkflowDetail";
import { DurationBars } from "./Workflows";
import { stepRows } from "./workflow-model";

function render(node: ReactNode, locale: Locale = "de"): string {
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <UiProvider lang={locale}>{node}</UiProvider>
    </I18nContext.Provider>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("KPI cards", () => {
  const card = (over: Partial<KpiCard>): KpiCard => ({
    id: "runs",
    label: "Runs · 24 Std",
    value: "21",
    note: null,
    href: null,
    trend: null,
    dots: null,
    detail: null,
    tone: null,
    link: null,
    retry: false,
    ...over,
  });

  test("a card shows label, value and a labelled trend", () => {
    const html = render(<OverviewKpis cards={[card({ trend: [1, 3, 2] })]} />);
    expect(html).toContain('aria-label="Verlauf: Runs · 24 Std"');
    expect(text(html)).toBe("Runs · 24 Std 21");
  });

  test("connector health draws one dot per connector and says it in words", () => {
    const html = render(
      <OverviewKpis
        cards={[card({ id: "connectorHealth", dots: { enabled: 4, notOk: 1, needsReauth: 1 } })]}
      />,
    );
    expect(html).toContain('aria-label="3 von 4 Connectors gesund"');
    expect(html.match(/bg-success|bg-destructive|bg-warning/g)?.length).toBe(4);
  });

  test("a figure without a value says why instead of drawing", () => {
    const html = render(<OverviewKpis cards={[card({ value: "—", note: "Nicht lesbar" })]} />);
    expect(text(html)).toContain("— Nicht lesbar");
    expect(html).not.toContain('role="img"');
  });

  test("a value links where the figure was counted", () => {
    const html = render(<OverviewKpis cards={[card({ href: "/cockpit/runs" })]} />);
    expect(html).toContain('href="/cockpit/runs"');
  });
});

describe("needs you", () => {
  test("a row shows tone tile, state, object, reason and one action", () => {
    const html = render(
      <NeedRow
        reason="needs_reauth"
        state="Anmeldung abgelaufen"
        title="HubSpot CRM"
        hint="Workflows laufen erst nach erneuter Anmeldung"
        action={
          <button type="button" data-testid="attention-item-0-primary">
            Neu anmelden
          </button>
        }
        testId="attention-item-0"
      />,
    );
    expect(html).toContain('data-need-tone="danger"');
    expect(text(html)).toBe(
      "Anmeldung abgelaufen HubSpot CRM Workflows laufen erst nach erneuter Anmeldung Neu anmelden",
    );
  });

  test("an empty list reads 'Alles erledigt'", () => {
    expect(text(render(<NeedsAllClear />))).toBe("Alles erledigt");
    expect(text(render(<NeedsAllClear />, "en"))).toBe("All clear");
  });
});

describe("runs", () => {
  test("a run row links to the run and shows outcome and time", () => {
    const html = render(
      <RunRow
        tone="danger"
        name="Daily report"
        outcome="Fehlgeschlagen"
        time="20.11. 08:00"
        href="/cockpit/runs/r1"
        testId="run"
      />,
    );
    expect(html).toContain('href="/cockpit/runs/r1"');
    expect(html).toContain("bg-destructive");
    expect(text(html)).toBe("Daily report Fehlgeschlagen 20.11. 08:00");
  });

  test("duration bars need two runs", () => {
    expect(render(<DurationBars data={[100]} />)).toBe("");
    expect(render(<DurationBars data={[100, 300]} />)).toContain(
      'aria-label="Dauer der letzten Runs"',
    );
  });
});

describe("approval limits", () => {
  const base = { validity: "revoked" as const, until: "2026-12-20", maxRuns: null };

  test("until revoked hides the date and leaves the run limit open", () => {
    const html = render(
      <ApprovalLimitsFields
        value={base}
        onChange={() => {}}
        disabled={false}
        problem={null}
        testId="limits"
      />,
    );
    expect(text(html)).toContain("Gültigkeit");
    expect(text(html)).toContain("Bis auf Widerruf");
    expect(html).not.toContain('data-testid="limits-until"');
    expect(html).toContain('placeholder="Ohne Grenze"');
  });

  test("a date shows the date field and names a past date", () => {
    const html = render(
      <ApprovalLimitsFields
        value={{ ...base, validity: "date", until: "2026-11-01" }}
        onChange={() => {}}
        disabled={false}
        problem="date_past"
        testId="limits"
      />,
    );
    expect(html).toContain('data-testid="limits-until"');
    expect(html).toContain('data-testid="limits-until" value="01.11.2026"');
    expect(text(html)).toContain("Wähle heute oder ein späteres Datum.");
  });

  test("an invalid run limit is named at the field", () => {
    const html = render(
      <ApprovalLimitsFields
        value={{ ...base, maxRuns: 0 }}
        onChange={() => {}}
        disabled={false}
        problem="runs_invalid"
        testId="limits"
      />,
      "en",
    );
    expect(text(html)).toContain("Enter a whole number from 1 to 10,000.");
    expect(html).toContain('aria-invalid="true"');
  });
});

describe("run result document", () => {
  test("renders the Markdown result with one truncation line, nothing without a result", () => {
    const html = render(
      <RunResultDocument result={{ text: "# Bericht\n\nAlles gut", truncated: true }} testId="r" />,
    );
    expect(html).toContain("Ergebnis");
    expect(html).toContain("Bericht");
    expect(html).toContain('data-testid="r-truncated"');
    expect(render(<RunResultDocument result={null} testId="r" />)).toBe("");
    expect(
      render(<RunResultDocument result={{ text: "ok", truncated: false }} testId="r" />),
    ).not.toContain("r-truncated");
  });
});

describe("pair approval card", () => {
  const NOW = Date.parse("2026-11-21T12:00:00.000Z");
  const pair = {
    id: "p1",
    state: "pending" as const,
    stale_reason: null,
    first_approver: { user_id: "lena", name: "Lena Hoffmann" },
    second_approver: null,
    expires_at: "2026-11-24T12:00:00.000Z",
    viewer_can_approve: true,
  };
  const card = (viewerId: string, failure: "pair_same_person" | null = null) =>
    render(
      <PairApprovalCard
        pair={pair}
        viewerId={viewerId}
        now={NOW}
        pending={null}
        failure={failure}
        onAction={() => {}}
      />,
    );

  test("shows two person slots, the first filled, the second open", () => {
    const html = card("max");
    expect(html).toContain('data-testid="pair-approval-first" data-filled="true"');
    expect(html).toContain('data-testid="pair-approval-second" data-filled="false"');
    expect(html).toContain("Lena Hoffmann");
    expect(html).toContain("Wartet auf zweite Freigabe");
  });

  test("the second person approves or declines, the first can only withdraw", () => {
    const other = card("max");
    expect(other).toContain('data-testid="pair-approval-approve"');
    expect(other).toContain('data-testid="pair-approval-decline"');
    expect(other).not.toContain('data-testid="pair-approval-withdraw"');
    const first = card("lena");
    expect(first).toContain('data-testid="pair-approval-withdraw"');
    expect(first).not.toContain('data-testid="pair-approval-approve"');
  });

  test("the same person approving twice is told through the error notice", () => {
    const html = card("lena", "pair_same_person");
    expect(html).toContain('data-testid="pair-approval-failure"');
    expect(html).toContain("Die zweite gibt jemand anderes.");
  });

  test("a card opened from a link is focusable for the jump", () => {
    const html = render(
      <PairApprovalCard
        pair={pair}
        viewerId="max"
        now={NOW}
        pending={null}
        failure={null}
        linked
        onAction={() => {}}
      />,
    );
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('data-linked="true"');
    expect(card("max")).not.toContain("tabindex");
  });
});

describe("pair link notice", () => {
  const NOW = Date.parse("2026-11-21T12:00:00.000Z");
  const base = {
    id: "p1",
    stale_reason: null,
    first_approver: { user_id: "lena", name: "Lena Hoffmann" },
    second_approver: null,
    expires_at: "2026-11-24T12:00:00.000Z",
    viewer_can_approve: true,
  };

  test("a closed request is one line through the error notice", () => {
    const html = render(
      <PairLinkNotice
        target={pairLinkTarget(
          "p1",
          [{ ...base, state: "declined", decided_at: "2026-11-21T10:00:00.000Z" }],
          NOW,
        )}
      />,
    );
    expect(html).toContain('data-testid="pair-link-closed"');
    expect(text(html)).toContain("Diese Anfrage ist schon geschlossen");
    expect(text(html)).toContain("Abgelehnt");
    expect(html).toContain('data-testid="pair-link-closed-technical-toggle"');
  });

  test("an unknown request says so", () => {
    const html = render(<PairLinkNotice target={pairLinkTarget("gone", [], NOW)} />);
    expect(html).toContain('data-testid="pair-link-missing"');
    expect(text(html)).toContain("Diese Anfrage gibt es nicht mehr");
  });

  test("open, loading and no link render nothing", () => {
    const open = pairLinkTarget("p1", [{ ...base, state: "pending" }], NOW);
    expect(render(<PairLinkNotice target={open} />)).toBe("");
    expect(render(<PairLinkNotice target={{ kind: "loading", id: "p1" }} />)).toBe("");
    expect(render(<PairLinkNotice target={{ kind: "none" }} />)).toBe("");
  });
});

describe("workflow detail", () => {
  const rows = stepRows([
    {
      id: "fetch",
      kind: "request",
      name: "Fetch",
      connector: "Gmail",
      target: "inbox",
      writes: false,
      lastStatus: "succeeded",
    },
    {
      id: "send",
      kind: "request",
      name: "Send",
      connector: "Slack",
      target: "post",
      writes: true,
      lastStatus: null,
    },
  ]);

  test("the steps panel names reads, writes and the boundary once", () => {
    const html = text(render(<WorkflowStepsPanel rows={rows} />));
    expect(html).toContain("Liest: Gmail: inbox · Schreibt: nichts");
    expect(html).toContain("Grenze: 1 Lesen · 1 Schreiben · 2 Dienste");
  });

  test("the current approval shows its facts and runs used, or says there is none", () => {
    const html = text(
      render(
        <CurrentApprovalBody
          rows={[{ label: "Umgebung", value: "Echtbetrieb" }]}
          used="3 von 10 Runs genutzt"
        />,
      ),
    );
    expect(html).toContain("Umgebung Echtbetrieb");
    expect(html).toContain("3 von 10 Runs genutzt");
    expect(text(render(<CurrentApprovalBody rows={null} used={null} />))).toContain(
      "Keine aktive Freigabe.",
    );
  });
});
