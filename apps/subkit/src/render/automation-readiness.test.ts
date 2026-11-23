import { expect, test } from "bun:test";
import { stripVTControlCharacters as plain } from "node:util";
import { formatAutomationReadiness } from "./automation-readiness.ts";

test("a repair-required readiness names each blocked step with its remedy", () => {
  const output = plain(
    formatAutomationReadiness({
      environment: "prod",
      workflow_version_id: "version",
      state: "repair_required",
      issues: [
        { step_id: "send_email", code: "dynamic_request" },
        { step_id: "mark_sent", code: "no_boundary" },
      ],
      repair_guidance: [
        { step_id: "send_email", code: "dynamic_request", instruction: "Declare report_delivery." },
      ],
    }),
  );
  expect(output).toContain("repair required");
  expect(output).toContain("send_email (dynamic_request): Declare report_delivery.");
  expect(output).toContain("mark_sent (no_boundary)");
});

test("an eligible readiness says a person approves it and a missing one prints nothing", () => {
  expect(
    plain(
      formatAutomationReadiness({
        environment: "dev",
        workflow_version_id: null,
        state: "eligible",
        issues: [],
        repair_guidance: [],
      }),
    ),
  ).toContain("a person approves them in Cockpit");
  expect(formatAutomationReadiness(undefined)).toBe("");
});

test("a connector gap names the connector, its environment and the attach command", () => {
  const output = plain(
    formatAutomationReadiness({
      environment: "prod",
      workflow_version_id: "version",
      state: "repair_required",
      issues: [],
      repair_guidance: [
        {
          step_id: "fetch_beta_group",
          code: "connector_unavailable",
          instruction:
            'The production connector "App Store Connect" (app-store-connect, prod) has no stored credential. Store it with `subkit vault attach app-store-connect --env prod`.',
        },
      ],
    }),
  );
  expect(output).toContain("until these connectors are ready");
  expect(output).toContain("fetch_beta_group (connector_unavailable)");
  expect(output).toContain('"App Store Connect" (app-store-connect, prod)');
  expect(output).toContain("subkit vault attach app-store-connect --env prod");
});
