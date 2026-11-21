import { expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import type { SetupAnswers } from "./model/setup-model";
import { SetupQuestion } from "./setup-question";

const answers: SetupAnswers = {
  job: null,
  jobOther: "",
  services: [],
  approver: "self",
  approverEmail: "",
  env: "dev",
  notify: "working_hours",
  from: "08:00",
  to: "18:00",
  at: "08:00",
  days: [1, 2, 3, 4, 5],
  timezone: "Europe/Berlin",
  critical: true,
  budget: 50,
};

function question(value: SetupAnswers, locale: "de" | "en" = "de"): string {
  return render(<SetupQuestion k="notify" value={value} onDone={() => {}} />, locale);
}

test("a schedule asks for the time zone and whether critical items break through", () => {
  const html = question(answers);
  expect(html).toContain('data-testid="setup-notify-timezone"');
  expect(html).toContain("Europe/Berlin");
  expect(html).toContain('data-testid="setup-notify-critical"');
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain("Kritisches darf Ruhezeiten durchbrechen");
  expect(html).toContain(
    "Kritisch: ein angehaltener Workflow im Echtbetrieb oder ein unlesbares Geheimnis.",
  );
  expect(html).toContain('data-testid="setup-notify-from"');
  const daily = question({ ...answers, notify: "daily_digest", critical: false }, "en");
  expect(daily).toContain('data-testid="setup-notify-at"');
  expect(daily).toContain("Critical items may break through quiet hours");
  expect(daily).toContain('aria-checked="false"');
});

test("notifying right away has no schedule, so it asks for neither", () => {
  const html = question({ ...answers, notify: "immediately" });
  expect(html).not.toContain("setup-notify-timezone");
  expect(html).not.toContain("setup-notify-critical");
});

test("working hours offer the weekdays, Monday to Friday chosen by default", () => {
  const html = question(answers);
  expect(html).toContain('data-testid="setup-notify-days"');
  for (const day of [1, 2, 3, 4, 5])
    expect(html).toMatch(
      new RegExp(`aria-pressed="true"[^>]*data-testid="setup-notify-day-${day}"`),
    );
  for (const day of [6, 7])
    expect(html).toMatch(
      new RegExp(`aria-pressed="false"[^>]*data-testid="setup-notify-day-${day}"`),
    );
  expect(html).toContain("Arbeitstage");
  expect(question({ ...answers, notify: "daily_digest" })).not.toContain("setup-notify-days");
});

test("the approver question hides approving together unless the workspace offers it", () => {
  const hidden = render(<SetupQuestion k="approver" value={answers} onDone={() => {}} />, "de");
  expect(hidden).toContain('data-testid="setup-approver-teammate"');
  expect(hidden).not.toContain('data-testid="setup-approver-pair"');
  expect(hidden).not.toContain("Gemeinsam freigeben");
  const offered = render(
    <SetupQuestion k="approver" value={answers} onDone={() => {}} offerPair />,
    "de",
  );
  expect(offered).toContain('data-testid="setup-approver-pair"');
});

test("the budget question offers 20, 50 recommended, 200 and no limit", () => {
  const html = render(<SetupQuestion k="budget" value={answers} onDone={() => {}} />, "de");
  for (const choice of [20, 50, 200, 0]) expect(html).toContain(`setup-budget-${choice}`);
  expect(html).toContain("50 $");
  expect(html).toContain("empfohlen");
  expect(html).toContain("Ohne Grenze");
});
