import { describe, expect, test } from "bun:test";
import type { AutomationState } from "@/lib/automation-state";
import { CATALOGS } from "@/lib/i18n";
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
    health: "ok",
    failedRunId: null,
    repairPrepared: false,
    rights: { write: true, chat: true },
    ...overrides,
  };
}

describe("workflow status strip (D15)", () => {
  test("a calm approved workflow has no action", () => {
    expect(workflowStrip(input({}))).toEqual({
      kind: "approved",
      tone: "ok",
      action: null,
      lower: [],
    });
  });

  test("stopped outranks a pending approval, failing runs and an open repair", () => {
    const strip = workflowStrip(
      input({
        automation: state({
          state: "paused",
          primaryAction: { kind: "resume", scheduleIds: ["s1"] },
        }),
        health: "degraded",
        failedRunId: "r1",
        repairPrepared: true,
      }),
    );
    expect(strip.kind).toBe("paused");
    expect(strip.action).toEqual({ kind: "resume", scheduleIds: ["s1"] });
    expect(strip.lower).toEqual(["failing", "repairPrepared"]);
  });

  test("waiting for approval opens the approval dialog, and only with the right", () => {
    const pending = state({ state: "grant", primaryAction: { kind: "grant" } });
    expect(workflowStrip(input({ automation: pending })).action).toEqual({
      kind: "approve",
      via: "grant",
    });
    expect(
      workflowStrip(input({ automation: pending, rights: { write: false, chat: true } })).action,
    ).toBeNull();
  });

  test("failing runs lead to the newest failed run", () => {
    const strip = workflowStrip(input({ health: "failing", failedRunId: "run-7" }));
    expect(strip).toMatchObject({
      kind: "failing",
      tone: "error",
      action: { kind: "cause", runId: "run-7" },
    });
  });

  test("an approval running out is extended; below failing runs it is only counted", () => {
    const expiring = state({
      primaryAction: { kind: "view" },
      secondaryAction: { kind: "extend" },
    });
    expect(workflowStrip(input({ automation: expiring })).action).toEqual({
      kind: "approve",
      via: "extend",
    });
    const both = workflowStrip(
      input({ automation: expiring, health: "failing", failedRunId: "r" }),
    );
    expect(both.kind).toBe("failing");
    expect(both.lower).toEqual(["expiring"]);
  });

  test("a filed repair is reviewed", () => {
    expect(workflowStrip(input({ repairPrepared: true })).action).toEqual({ kind: "review" });
  });

  test("a refused step leaves its acts to the diagnosis", () => {
    const strip = workflowStrip(input({ automation: state({ state: "repair" }) }));
    expect(strip).toMatchObject({ kind: "repair", tone: "error", action: null });
  });

  test("an unread approval list is a failure with a retry, never a calm state", () => {
    expect(workflowStrip(input({ failed: true }))).toMatchObject({
      kind: "failed",
      action: { kind: "retry" },
    });
  });

  test("on request: calm, and the approval is still offered", () => {
    const manual = state({ state: "manual", primaryAction: { kind: "grant" } });
    expect(workflowStrip(input({ automation: manual }))).toMatchObject({
      kind: "manual",
      tone: "ok",
      action: { kind: "approve", via: "grant" },
    });
  });

  test("every state and action has words in both languages", () => {
    const keys = [
      ...Object.values(STRIP_STATE_KEYS),
      stripActionKey({ kind: "approve", via: "grant" }),
      stripActionKey({ kind: "approve", via: "extend" }),
      stripActionKey({ kind: "cause", runId: "r" }),
    ];
    for (const key of keys) {
      expect(CATALOGS.en[key]).toBeTruthy();
      expect(CATALOGS.de[key]).toBeTruthy();
    }
    expect(CATALOGS.de[stripActionKey({ kind: "approve", via: "grant" })]).toBe("Freigeben…");
    expect(CATALOGS.de[stripActionKey({ kind: "cause", runId: "r" })]).toBe("Ursache ansehen");
  });
});
