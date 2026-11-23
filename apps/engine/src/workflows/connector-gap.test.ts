import { describe, expect, test } from "bun:test";
import {
  connectorGap,
  connectorGapGuidance,
  connectorGapInstruction,
  vaultAttachCommand,
} from "./connector-gap.ts";

const CONNECTOR_ID = "5eed0003-0000-4000-8000-000000000001";
const unavailable = {
  step_id: "fetch_beta_group",
  connector_id: CONNECTOR_ID,
  connector_slug: "app-store-connect",
  connector_name: "App Store Connect",
  reason: "credential_unavailable" as const,
};

describe("connector gap", () => {
  test("names the record, its environment and the reconnect target", () => {
    expect(connectorGap(unavailable, "prod")).toEqual({
      connector: {
        connector_id: CONNECTOR_ID,
        connector_slug: "app-store-connect",
        connector_name: "App Store Connect",
        environment: "prod",
        reason: "credential_unavailable",
      },
      reconnect: { connector_id: CONNECTOR_ID, environment: "prod", section: "credentials" },
    });
  });

  test("a missing credential names the exact attach command", () => {
    const { connector } = connectorGap(unavailable, "prod");
    expect(vaultAttachCommand(connector)).toBe("subkit vault attach app-store-connect --env prod");
    const instruction = connectorGapInstruction(connector);
    expect(instruction).toContain('"App Store Connect" (app-store-connect, prod)');
    expect(instruction).toContain("`subkit vault attach app-store-connect --env prod`");
  });

  test("a disabled or signed-out connector asks for that instead of a credential", () => {
    const disabled = connectorGap({ ...unavailable, reason: "disabled" }, "dev").connector;
    expect(connectorGapInstruction(disabled)).toContain("is disabled");
    expect(connectorGapInstruction(disabled)).not.toContain("vault attach");
    const signedOut = connectorGap({ ...unavailable, reason: "needs_reauth" }, "dev").connector;
    expect(connectorGapInstruction(signedOut)).toContain("signed in again");
  });

  test("guidance covers only connector_unavailable diagnoses with evidence", () => {
    const { connector } = connectorGap(unavailable, "prod");
    expect(
      connectorGapGuidance([
        {
          code: "connector_unavailable",
          subject: { step_id: "fetch_beta_group" },
          evidence: { connector },
        },
        { code: "connector_unavailable", subject: { step_id: "other" }, evidence: {} },
        { code: "missing_binding", subject: { step_id: "send" }, evidence: {} },
      ]),
    ).toEqual([
      {
        step_id: "fetch_beta_group",
        code: "connector_unavailable",
        instruction: connectorGapInstruction(connector),
      },
    ]);
  });
});
