import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  mayReportProblem,
  REPORT_WORKFLOW_SLUG,
  type ReportWorkflow,
  reportWorkflowOf,
} from "./report-problem";

const workflow = (overrides: Partial<ReportWorkflow> = {}) =>
  ({
    id: "wf-report",
    slug: REPORT_WORKFLOW_SLUG,
    lifecycle: "active",
    invalid: false,
    current_version_id: "ver-1",
    connector_references: [
      { step_id: "send", connector_id: "c1", slug: "s", name: "S", reason: "available" },
    ],
    ...overrides,
  }) as ReportWorkflow;

describe("reporting a problem", () => {
  test("needs the right to run and to read workflows", () => {
    expect(mayReportProblem(["workflow:run", "workflow:read"])).toBe(true);
    expect(mayReportProblem(["workflow:read"])).toBe(false);
    expect(mayReportProblem(["workflow:run"])).toBe(false);
    expect(mayReportProblem([])).toBe(false);
  });

  test("finds exactly the reporting workflow among similar ones", () => {
    const other = workflow({ id: "wf-other", slug: `${REPORT_WORKFLOW_SLUG}-diagnostics` });
    expect(reportWorkflowOf([other, workflow()])?.id).toBe("wf-report");
    expect(reportWorkflowOf([other])).toBeNull();
    expect(reportWorkflowOf([])).toBeNull();
  });

  test("a switched-off, outdated, unsaved or unconnected workflow counts as not set up", () => {
    expect(reportWorkflowOf([workflow({ lifecycle: "archived" })])).toBeNull();
    expect(reportWorkflowOf([workflow({ invalid: true })])).toBeNull();
    expect(reportWorkflowOf([workflow({ current_version_id: null })])).toBeNull();
    expect(
      reportWorkflowOf([
        workflow({
          connector_references: [
            { step_id: "send", connector_id: null, slug: null, name: null, reason: "missing" },
          ],
        }),
      ]),
    ).toBeNull();
  });

  test("the texts are plain in both languages", () => {
    const banned = /workflow|connector|konnektor|slug|recipe|rezept|ablauf/i;
    for (const locale of ["de", "en"] as const)
      for (const key of [
        "report.menu",
        "report.title",
        "report.intro",
        "report.field.title",
        "report.field.titleHelp",
        "report.field.description",
        "report.field.descriptionHelp",
        "report.submit",
        "report.sent",
        "report.loading",
        "report.notSetUp",
        "report.unreadable",
        "report.refused",
      ] as const)
        expect(translate(locale, key)).not.toMatch(banned);
    expect(translate("de", "report.menu")).toBe("Problem melden");
    expect(translate("en", "report.menu")).toBe("Report a problem");
  });
});
