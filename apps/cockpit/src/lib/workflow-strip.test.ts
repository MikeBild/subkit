import { describe, expect, test } from "bun:test";
import type { AutomationState } from "@/lib/automation-state";
import { CATALOGS } from "@/lib/i18n";
import type { WorkflowAuthority } from "@/lib/workflow-authorities";
import {
  STRIP_STATE_KEYS,
  type StripInput,
  stripActionKey,
  workflowStrip,
} from "@/lib/workflow-strip";

function state(overrides: Partial<AutomationState>): AutomationState {
  return {
    state: "approved",
    environment: "prod",
    target: { kind: "running", version_id: "v", version: 3 },
    facts: {
      version: 3,
      preparedVersion: null,
      validUntil: null,
      runsLeft: null,
      runsMax: null,
      runsSoFar: null,
      untilRevoked: true,
      blockedStep: null,
      inactive: false,
    },
    grant: null,
    alsoValid: [],
    history: [],
    triggers: [],
    pendingEnvironments: [],
    primaryAction: null,
    secondaryAction: null,
    ...overrides,
  } as AutomationState;
}

function input(overrides: Partial<StripInput>): StripInput {
  return {
    automation: state({}),
    failed: false,
    disabled: false,
    health: "ok",
    failedRunId: null,
    repairPrepared: false,
    waitingConnector: null,
    rights: { write: true, chat: true },
    ...overrides,
  };
}

describe("workflow status strip (D15, reviewed)", () => {
  test("a calm approved workflow runs and offers nothing", () => {
    expect(workflowStrip(input({}))).toEqual({
      kind: "approved",
      tone: "ok",
      action: null,
      lower: [],
    });
  });

  test("switched off leads, and is switched on again", () => {
    const strip = workflowStrip(input({ disabled: true, health: "degraded", failedRunId: "r" }));
    expect(strip).toMatchObject({ kind: "disabled", action: { kind: "enable" } });
    expect(strip.lower).toEqual(["failing"]);
  });

  test("an approval that ran out stops the workflow; a first one waits", () => {
    const pending = state({ state: "grant", primaryAction: { kind: "grant" } });
    expect(workflowStrip(input({ automation: pending })).kind).toBe("grant");
    const stopped = state({
      state: "grant",
      primaryAction: { kind: "grant" },
      history: [{ id: "a" } as WorkflowAuthority],
    });
    expect(workflowStrip(input({ automation: stopped }))).toMatchObject({
      kind: "stopped",
      tone: "error",
      action: { kind: "approve", via: "grant" },
    });
    expect(
      workflowStrip(input({ automation: pending, rights: { write: false, chat: true } })).action,
    ).toBeNull();
  });

  test("refused steps leave their acts to the diagnosis", () => {
    const strip = workflowStrip(input({ automation: state({ state: "repair" }) }));
    expect(strip).toMatchObject({ kind: "repair", action: null });
  });

  test("on request without an approval: not approved, and the approval is offered", () => {
    const manual = state({ state: "manual", primaryAction: { kind: "grant" } });
    expect(workflowStrip(input({ automation: manual }))).toMatchObject({
      kind: "unapproved",
      action: { kind: "approve", via: "grant" },
    });
  });

  test("a connector without a sign-in makes the workflow wait for it", () => {
    const strip = workflowStrip(
      input({
        waitingConnector: { id: "c1", name: "Mail", state: "expired" },
        health: "degraded",
        failedRunId: "r",
      }),
    );
    expect(strip).toMatchObject({
      kind: "connector",
      action: { kind: "connector", connectorId: "c1" },
    });
    expect(strip.lower).toEqual(["failing"]);
  });

  test("failing runs lead to the newest failed run", () => {
    expect(workflowStrip(input({ health: "failing", failedRunId: "run-7" }))).toMatchObject({
      kind: "failing",
      tone: "error",
      action: { kind: "cause", runId: "run-7" },
    });
  });

  test("an approval running out is extended; a filed repair is reviewed", () => {
    const expiring = state({
      primaryAction: { kind: "view" },
      secondaryAction: { kind: "extend" },
    });
    expect(workflowStrip(input({ automation: expiring })).action).toEqual({
      kind: "approve",
      via: "extend",
    });
    expect(workflowStrip(input({ repairPrepared: true })).action).toEqual({ kind: "review" });
  });

  test("an unread approval list is a failure with a retry, never a calm state", () => {
    expect(workflowStrip(input({ failed: true }))).toMatchObject({
      kind: "failed",
      action: { kind: "retry" },
    });
  });

  test("every state and action has words in both languages", () => {
    const keys = [
      ...Object.values(STRIP_STATE_KEYS),
      stripActionKey({ kind: "approve", via: "grant" }),
      stripActionKey({ kind: "approve", via: "extend" }),
      stripActionKey({ kind: "cause", runId: "r" }),
      stripActionKey({ kind: "connector", connectorId: "c" }),
      stripActionKey({ kind: "enable" }),
    ];
    for (const key of keys) {
      expect(CATALOGS.en[key]).toBeTruthy();
      expect(CATALOGS.de[key]).toBeTruthy();
    }
    expect(CATALOGS.de[stripActionKey({ kind: "approve", via: "grant" })]).toBe("Freigeben…");
  });
});
