import { describe, expect, test } from "bun:test";
import { approvalChoice } from "@shared/approval-choice.ts";
import { render } from "@/components/cockpit/patterns/test-utils";
import { approvalRemedyLink, reviewedEnvironment } from "@/features/grants/model/grant-decision";
import type { WorkflowAuthorityPreview } from "@/features/grants/model/workflow-authorities";
import { translate } from "@/lib/i18n";
import { GrantEnvironmentDecision } from "./grant-environment";

type Environments = WorkflowAuthorityPreview["environments"];
type Recommended = WorkflowAuthorityPreview["recommended_environment"];
type Block = Environments["dev"]["reasons"][number];

const open = { possible: true, reasons: [] };
const blocked = (...reasons: Block[]) => ({ possible: false, reasons });
const support = (code: Block["code"]): Block => ({
  code,
  step_id: "ask",
  connector_id: "11111111-1111-4111-8111-111111111111",
  connector_name: "SubKit Support Admin",
});

function preview(
  environments: Environments,
  recommended: Recommended,
  schedules: WorkflowAuthorityPreview["schedules"] = [],
): WorkflowAuthorityPreview {
  return {
    environments,
    recommended_environment: recommended,
    schedules,
  } as unknown as WorkflowAuthorityPreview;
}

const show = (
  value: WorkflowAuthorityPreview,
  locale: "de" | "en" = "de",
  environment: "dev" | "prod" = "dev",
) =>
  render(
    <GrantEnvironmentDecision
      preview={value}
      environment={environment}
      busy={false}
      onSelect={() => {}}
    />,
    locale,
  );

const onlyTest = preview(
  { dev: open, prod: blocked(support("connector_missing")) },
  { environment: "dev", reason: "only_possible" },
);

const checked = (html: string, environment: "dev" | "prod") =>
  new RegExp(
    `data-state="checked"[^>]*data-testid="authority-environment-${environment}"|data-testid="authority-environment-${environment}"[^>]*data-state="checked"`,
  ).test(html);
const disabled = (html: string, environment: "dev" | "prod") =>
  new RegExp(`disabled=""[^>]*data-testid="authority-environment-${environment}"`).test(html);

describe("one possible environment", () => {
  test("shows both options, fixes the possible one and says why", () => {
    const html = show(onlyTest);
    expect(html).toContain("Umgebung");
    expect(checked(html, "dev")).toBe(true);
    expect(disabled(html, "prod")).toBe(true);
    expect(disabled(html, "dev")).toBe(false);
    expect(html).toContain("SubKit Support Admin gibt es im Echtbetrieb nicht.");
    expect(html).not.toContain("löst sich auf");
    const en = show(onlyTest, "en");
    expect(en).toContain("Environment");
    expect(en).toContain("SubKit Support Admin does not exist in Production.");
  });

  test("names the sign-in problem of the other environment", () => {
    const html = show(
      preview(
        { dev: open, prod: blocked(support("connector_needs_sign_in_again")) },
        { environment: "dev", reason: "only_possible" },
      ),
    );
    expect(html).toContain("SubKit Support Admin muss im Echtbetrieb neu angemeldet werden.");
  });

  test("a production connector without a credential offers to open that connector", () => {
    const html = show(
      preview(
        { dev: open, prod: blocked(support("connector_without_sign_in")) },
        { environment: "dev", reason: "only_possible" },
      ),
    );
    expect(checked(html, "dev")).toBe(true);
    expect(html.match(/authority-decision-single-remedy/g)?.length).toBe(1);
    expect(html).toContain(translate("de", "run.openConnector"));
    expect(html).toContain("/connectors/11111111-1111-4111-8111-111111111111");
  });

  test("a reason other than a blocked environment offers no connector", () => {
    const html = show(
      preview({ dev: open, prod: open }, { environment: "prod", reason: "schedule" }),
      "de",
      "prod",
    );
    expect(html).not.toContain("authority-decision-single-remedy");
  });

  test("the schedule names when it starts", () => {
    const html = show(
      preview({ dev: open, prod: open }, { environment: "prod", reason: "schedule" }, [
        { cron: "0 7 * * *", timezone: "Europe/Berlin", next_run_at: null },
      ]),
    );
    expect(html).toContain("Der Zeitplan startet ihn dort, täglich um 07:00.");
    expect(checked(html, "prod")).toBe(true);
    expect(disabled(html, "dev")).toBe(true);
  });

  test.each([
    ["inbound_hook", "Aufrufe von außen starten ihn dort."],
    ["existing_approval", "Dort gibt es schon eine Freigabe."],
    ["schedule", "Der Zeitplan startet ihn dort."],
  ] as const)("%s", (reason, sentence) => {
    const html = show(
      preview({ dev: open, prod: open }, { environment: "prod", reason }),
      "de",
      "prod",
    );
    expect(html).toContain(sentence);
    expect(checked(html, "prod")).toBe(true);
    expect(disabled(html, "dev")).toBe(true);
  });
});

describe("two possible environments", () => {
  const both = preview(
    { dev: open, prod: open },
    { environment: "dev", reason: "started_manually" },
  );

  test("offers the selector with one consequence per option", () => {
    const html = show(both);
    expect(html).toContain('data-testid="authority-environment-dev"');
    expect(html).toContain('data-testid="authority-environment-prod"');
    expect(html).toContain("Umgebung");
    expect(disabled(html, "dev") || disabled(html, "prod")).toBe(false);
    expect(html).toContain("Test: zum Ausprobieren. Du startest ihn selbst.");
    expect(html).not.toContain("Echtbetrieb: arbeitet mit deinen echten Daten.");
    expect(show(both, "de", "prod")).toContain("Echtbetrieb: arbeitet mit deinen echten Daten.");
    expect(show(both, "en")).toContain("Environment");
  });

  test("preselects the environment it is given", () => {
    expect(show(both, "de", "dev")).toMatch(
      /data-state="checked"[^>]*data-testid="authority-environment-dev"|data-testid="authority-environment-dev"[^>]*data-state="checked"/,
    );
    expect(show(both, "de", "prod")).toMatch(
      /data-state="checked"[^>]*data-testid="authority-environment-prod"|data-testid="authority-environment-prod"[^>]*data-state="checked"/,
    );
  });
});

describe("no possible environment", () => {
  const none = preview(
    {
      dev: blocked(support("connector_without_sign_in")),
      prod: blocked(support("connector_missing")),
    },
    { environment: null, reason: "none_possible" },
  );

  test("lists each reason, offers one remedy and no selector", () => {
    const html = show(none);
    expect(html).toContain("SubKit Support Admin hat im Test keine Anmeldung.");
    expect(html).toContain("SubKit Support Admin gibt es im Echtbetrieb nicht.");
    expect(html).not.toContain("authority-environment");
    expect(html.match(/authority-decision-remedy/g)?.length).toBe(1);
    expect(html).toContain("Connector öffnen");
    expect(html).toContain("/connectors/11111111-1111-4111-8111-111111111111");
  });

  test("a sign-in that expired is signed in again", () => {
    const html = show(
      preview(
        {
          dev: blocked(support("connector_needs_sign_in_again")),
          prod: blocked(support("connector_missing"), support("connector_missing")),
        },
        { environment: null, reason: "none_possible" },
      ),
      "en",
    );
    expect(html).toContain("SubKit Support Admin must be signed in again in Test.");
    expect(html).toContain("Sign in again");
    expect(html).toContain("#connector-credentials");
  });

  test("without a connector id there is no link", () => {
    expect(
      approvalRemedyLink({
        kind: "open_connector",
        environment: "dev",
        step_id: "ask",
        connector_id: null,
      }),
    ).toBeNull();
  });
});

describe("the environment the review opens in", () => {
  const choice = approvalChoice(
    preview({ dev: open, prod: open }, { environment: "dev", reason: "started_manually" }),
  );
  const single = approvalChoice(onlyTest);

  test("follows the engine for one possible environment", () => {
    expect(reviewedEnvironment({ choice: single, asked: "prod", pinned: false })).toBe("dev");
  });

  test("a hint decides only when both are possible", () => {
    expect(reviewedEnvironment({ choice, asked: "dev", pinned: false, hint: "prod" })).toBe("prod");
    expect(reviewedEnvironment({ choice, asked: "dev", pinned: false })).toBe("dev");
    expect(
      reviewedEnvironment({ choice: single, asked: "prod", pinned: false, hint: "prod" }),
    ).toBe("dev");
  });

  test("a pick by the reader holds while both are possible", () => {
    expect(reviewedEnvironment({ choice, asked: "prod", pinned: true })).toBe("prod");
    expect(reviewedEnvironment({ choice, asked: "dev", pinned: true, hint: "prod" })).toBe("dev");
  });

  test("a pinned review follows the engine when only one is possible", () => {
    expect(reviewedEnvironment({ choice: single, asked: "prod", pinned: true })).toBe("dev");
  });
});
