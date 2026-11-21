import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { loginHref } from "@/app/login-href";
import { render } from "@/components/cockpit/patterns/test-utils";
import {
  AUTHORITY_REPORT,
  CONNECTOR_NAMES,
  liveGrant,
  preview,
  QUOTE,
  REPORT,
  WF_QUOTE,
  WF_REPORT,
  workflow,
} from "../model/task-grant-fixtures";
import { blockedRows, taskGrantRows } from "../model/task-grant-model";

mock.module("@/app/session", () => ({
  loginHref,
  useSession: () => ({ permissions: [] }),
  useSessionUpdate: () => () => {},
}));

const { TaskGrantBlocked, TaskGrantRows } = await import("./task-grant-rows");

const shown = (element: ReactElement, locale: "de" | "en" = "de") =>
  render(<QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>, locale);
const rows = (input = preview()) => taskGrantRows(input, CONNECTOR_NAMES, "Unbekannt");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

describe("the rows of what a task may use", () => {
  test("say reads, writes and starts in plain words in both languages", () => {
    const german = text(shown(<TaskGrantRows rows={rows()} mode="review" testId="rows" />));
    expect(german).toContain("liest Buchhaltung");
    expect(german).toContain("schreibt Postfach");
    expect(german).toContain("startet Zahlungsabgleich liest Bank, schreibt Buchhaltung");
    const english = text(shown(<TaskGrantRows rows={rows()} mode="review" testId="rows" />, "en"));
    expect(english).toContain("reads Buchhaltung");
    expect(english).toContain("writes Postfach");
    expect(english).toContain("starts Zahlungsabgleich reads Bank, writes Buchhaltung");
  });

  test("a workflow opens into the existing effect review, worded as not compared with the server", () => {
    const markup = shown(<TaskGrantRows rows={rows()} mode="review" testId="rows" />);
    expect(markup).toContain('data-testid="task-grant-row-toggle-2"');
    expect(count(markup, 'data-testid="authority-effect-review"')).toBe(3);
  });

  test("before allowing, a workflow is marked when it is already approved or will ask", () => {
    const markup = shown(<TaskGrantRows rows={rows()} mode="review" testId="rows" />);
    expect(markup).not.toContain('data-testid="task-grant-standing-2"');
    expect(markup).toMatch(/data-testid="task-grant-standing-3"[^>]*data-standing="asks"/);
    expect(markup).toMatch(/data-testid="task-grant-standing-4"[^>]*data-standing="covered"/);
    expect(text(markup)).toContain("fragt jedes Mal");
    expect(text(markup)).toContain("schon erlaubt");
  });

  test("a task that uses nothing says so instead of showing an empty list", () => {
    const markup = shown(
      <TaskGrantRows
        rows={rows(preview({ workflows: [], connectors: [] }))}
        mode="review"
        testId="rows"
      />,
    );
    expect(text(markup)).toContain("Diese Aufgabe nutzt weder Workflows noch Connectors.");
    expect(markup).not.toContain("<ul");
  });

  test("on the tab an approval is shown as a workflow approval that links to the workflow", () => {
    const granted = preview({
      live_grant: liveGrant({ workflow_authority_ids: [AUTHORITY_REPORT] }),
      workflows: [
        workflow(),
        QUOTE,
        {
          ...REPORT,
          covering_authority: {
            id: AUTHORITY_REPORT,
            valid_until: "2026-12-01T00:00:00.000Z",
            remaining_runs: 5,
          },
        },
      ],
    });
    const markup = shown(<TaskGrantRows rows={rows(granted)} mode="standing" live testId="rows" />);
    expect(markup).toContain(`/cockpit/workflows/${WF_REPORT}#workflow-section-approvals`);
    expect(text(markup)).toContain("Workflow-Freigabe bis 2026-12-01T00:00:00.000Z · noch 5 Runs");
    expect(markup).toMatch(/data-testid="task-grant-standing-4"[^>]*data-standing="co_granted"/);
    expect(text(markup)).toContain("mit erlaubt");
    expect(markup).toMatch(/data-testid="task-grant-standing-2"[^>]*data-standing="asks"/);
    expect(markup).not.toContain('data-testid="authority-effect-review"');
  });

  test("on the tab an approval of its own carries no mark and a missing workflow no link", () => {
    const markup = shown(
      <TaskGrantRows
        rows={rows(
          preview({
            workflows: [REPORT, workflow({ name: null, blocked_reason: "workflow_missing" })],
          }),
        )}
        mode="standing"
        testId="rows"
      />,
    );
    expect(text(markup)).toContain("Workflow-Freigabe bis auf Widerruf");
    expect(markup).not.toContain('data-testid="task-grant-standing-2"');
    expect(markup).not.toContain('data-testid="task-grant-workflow-3"');
    expect(text(markup)).toContain("Unbekannter Workflow");
    expect(text(markup)).toContain("nicht verfügbar");
  });
});

describe("the notice about workflows that cannot be allowed permanently", () => {
  const notice = (input = preview(), links = true, locale: "de" | "en" = "de") =>
    shown(
      <TaskGrantBlocked
        blocked={blockedRows(rows(input))}
        environment="prod"
        links={links}
        testId="blocked"
      />,
      locale,
    );

  test("is one sentence that names the workflow and says it asks on every run", () => {
    expect(text(notice())).toContain(
      "„Angebot erstellen“ lässt sich nicht dauerhaft erlauben und fragt deshalb bei jedem Run.",
    );
    expect(text(notice(preview(), true, "en"))).toContain(
      "“Angebot erstellen” cannot be allowed permanently, so it asks on every run.",
    );
    expect(count(notice(), 'data-testid="blocked-sentence"')).toBe(1);
  });

  test("keeps the reason behind Warum? with one sentence and a way to the workflow", () => {
    const markup = notice();
    expect(markup).toContain('data-testid="blocked-why-toggle"');
    expect(text(markup)).toContain("Warum?");
    expect(text(markup)).toContain(
      "Dieser Workflow lässt sich noch nicht für wiederholte Runs freigeben, prüfe ihn auf seiner Seite.",
    );
    expect(markup).toContain(`/cockpit/workflows/${WF_QUOTE}"`);
    expect(notice(preview(), false)).not.toContain('data-testid="blocked-open-0"');
  });

  test.each([
    ["workflow_missing", "Diesen Workflow gibt es nicht mehr, entferne ihn aus der Aufgabe."],
    ["workflow_not_active", "Dieser Workflow ist nicht aktiv, aktiviere ihn auf seiner Seite."],
    [
      "workflow_sensitive",
      "Dieser Workflow ist vertraulich und lässt sich deshalb aus keiner Aufgabe starten.",
    ],
    [
      "workflow_not_readable",
      "Du darfst diesen Workflow nicht sehen, bitte eine Person mit Zugriff um die Freigabe.",
    ],
  ] as const)("%s is named without claiming that it asks", (blocked_reason, sentence) => {
    const markup = text(notice(preview({ workflows: [workflow({ blocked_reason })] })));
    expect(markup).toContain("„Zahlungsabgleich“ ist für diese Aufgabe nicht verfügbar.");
    expect(markup).toContain(sentence);
    expect(markup).not.toContain("fragt deshalb bei jedem Run");
  });

  test("a workflow the person may not approve asks every time and says whom to ask", () => {
    const markup = text(notice(preview({ workflows: [workflow({ may_grant: false })] })));
    expect(markup).toContain("fragt deshalb bei jedem Run");
    expect(markup).toContain(
      "Dir fehlt das Recht, diesen Workflow freizugeben, bitte eine Person darum, die es hat.",
    );
  });

  test("stays a single notice for several workflows and is absent when none is blocked", () => {
    const several = notice(
      preview({ workflows: [QUOTE, workflow({ blocked_reason: "workflow_missing" })] }),
    );
    expect(count(several, 'data-testid="blocked-sentence"')).toBe(1);
    expect(text(several)).toContain("2 Workflows lassen sich nicht dauerhaft erlauben.");
    expect(notice(preview({ workflows: [workflow()] }))).toBe("");
  });
});
