import { describe, expect, test } from "bun:test";
import { approvalChoice } from "@shared/approval-choice.ts";
import { GrantEnvironmentDecision } from "@/components/cockpit/grant-environment";
import { render } from "@/components/cockpit/patterns/test-utils";
import { approvalRemedyLink, reviewedEnvironment } from "@/lib/grant-decision";
import type { WorkflowAuthorityPreview } from "@/lib/workflow-authorities";

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

describe("one possible environment", () => {
  test("shows a sentence and no selector", () => {
    const html = show(onlyTest);
    expect(html).toContain("Gilt für den Test. SubKit Support Admin gibt es im Echtbetrieb nicht.");
    expect(html).toContain(
      "Test ist zum Ausprobieren. Der Echtbetrieb arbeitet mit deinen echten Daten.",
    );
    expect(html).not.toContain("authority-environment");
    expect(html).not.toContain("löst sich auf");
    expect(show(onlyTest, "en")).toContain(
      "Applies to Test. SubKit Support Admin does not exist in Production.",
    );
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

  test("the schedule names when it starts", () => {
    const html = show(
      preview({ dev: open, prod: open }, { environment: "prod", reason: "schedule" }, [
        { cron: "0 7 * * *", timezone: "Europe/Berlin", next_run_at: null },
      ]),
    );
    expect(html).toContain(
      "Gilt für den Echtbetrieb. Der Zeitplan startet ihn dort, täglich um 07:00.",
    );
    expect(html).not.toContain("authority-environment");
  });

  test.each([
    ["inbound_hook", "Gilt für den Echtbetrieb. Aufrufe von außen starten ihn dort."],
    ["existing_approval", "Gilt für den Echtbetrieb. Dort gibt es schon eine Freigabe."],
    ["schedule", "Gilt für den Echtbetrieb. Der Zeitplan startet ihn dort."],
  ] as const)("%s", (reason, sentence) => {
    const html = show(
      preview({ dev: open, prod: open }, { environment: "prod", reason }),
      "de",
      "prod",
    );
    expect(html).toContain(sentence);
    expect(html).not.toContain("authority-environment");
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
    expect(html).toContain("Wofür soll die Freigabe gelten?");
    expect(html).toContain("Test: zum Ausprobieren. Du startest ihn selbst.");
    expect(html).toContain("Echtbetrieb: arbeitet mit deinen echten Daten.");
    expect(show(both, "en")).toContain("What should the approval be for?");
  });

  test("preselects the environment it is given", () => {
    expect(show(both, "de", "dev")).toMatch(
      /data-state="on"[^>]*data-testid="authority-environment-dev"|data-testid="authority-environment-dev"[^>]*data-state="on"/,
    );
    expect(show(both, "de", "prod")).toMatch(
      /data-state="on"[^>]*data-testid="authority-environment-prod"|data-testid="authority-environment-prod"[^>]*data-state="on"/,
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
    expect(html).toContain("Konnektor öffnen");
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
