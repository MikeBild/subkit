import { describe, expect, test } from "bun:test";
import type { AutomationState } from "@/lib/automation-state";
import type { TranslationKey } from "@/lib/i18n";
import { workflowStrip } from "@/lib/workflow-strip";
import {
  authorityItems,
  automationHeadline,
  automationNow,
  automationSettled,
  hasPreparedDraft,
  openRepair,
  type StripLineInput,
  stripHelp,
  stripLine,
  unansweredChecks,
  verifiedStatus,
  waitingConnectorFor,
  weekStart,
  workflowSchedules,
  workflowVersions,
} from "./automation-panel-model";

const NOW = Date.parse("2026-11-21T12:00:00Z");

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  values ? `${key} ${JSON.stringify(values)}` : key;

const dateTime = (value: string) => `at ${value}`;

function state(
  partial: Partial<AutomationState> & Pick<AutomationState, "state">,
): AutomationState {
  return {
    environment: "prod",
    primaryAction: null,
    secondaryAction: null,
    target: null,
    triggers: [],
    facts: {
      version: 3,
      preparedVersion: null,
      validUntil: null,
      untilRevoked: false,
      runsLeft: null,
      runsMax: null,
      runsSoFar: null,
      blockedStep: null,
      inactive: false,
    },
    ...partial,
  } as unknown as AutomationState;
}

describe("automation snapshot", () => {
  test("the clock is the newest of the tick and every answer", () => {
    expect(automationNow(NOW, [NOW - 5, NOW + 7, 0])).toBe(NOW + 7);
    expect(automationNow(NOW, [])).toBe(NOW);
    expect(weekStart(NOW)).toBe("2026-11-14T12:00:00.000Z");
  });

  test("a draft counts as prepared only when it differs from the running version", () => {
    expect(hasPreparedDraft({ draft_version_id: "v2", current_version_id: "v1" })).toBe(true);
    expect(hasPreparedDraft({ draft_version_id: "v1", current_version_id: "v1" })).toBe(false);
    expect(hasPreparedDraft({ draft_version_id: null, current_version_id: "v1" })).toBe(false);
  });

  test("approval pages are flattened, one broken page makes the list unknown", () => {
    expect(authorityItems([{ items: [1, 2] }, { items: [3] }])).toEqual([1, 2, 3]);
    expect(authorityItems([{ items: [1] }, { items: null }])).toBeNull();
    expect(authorityItems(undefined)).toBeNull();
  });

  test("only this workflow's schedules count, a malformed answer is unknown", () => {
    const rows = [{ workflow_id: "wf-1" }, { workflow_id: "wf-2" }];
    expect(workflowSchedules(rows, "wf-1")).toEqual([{ workflow_id: "wf-1" }]);
    expect(workflowSchedules(undefined, "wf-1")).toBeNull();
  });

  test("a status answer is trusted only with schedules and inbound hooks", () => {
    const full = { schedules: [], inbound_hooks: [] };
    expect(verifiedStatus(full)).toBe(full);
    expect(verifiedStatus({ schedules: [] })).toBeNull();
    expect(verifiedStatus(null)).toBeNull();
  });

  test("the state settles once every readable answer is in", () => {
    const base = {
      authoritiesPending: false,
      schedulesPending: false,
      statusPending: true,
      draftPending: true,
      mayReadStatus: false,
      prepared: false,
    };
    expect(automationSettled(base)).toBe(true);
    expect(automationSettled({ ...base, mayReadStatus: true })).toBe(false);
    expect(automationSettled({ ...base, prepared: true })).toBe(false);
    expect(automationSettled({ ...base, authoritiesPending: true })).toBe(false);
  });

  test("a check counts as unanswered only when it was allowed and came back malformed", () => {
    const base = {
      mayReadStatus: true,
      statusPending: false,
      statusVerified: false,
      mayDiagnose: true,
      environmentKnown: true,
      diagnosisPending: false,
      diagnoses: undefined,
    };
    expect(unansweredChecks(base)).toEqual({ status: true, diagnosis: true });
    expect(unansweredChecks({ ...base, statusVerified: true, diagnoses: [] })).toEqual({
      status: false,
      diagnosis: false,
    });
    expect(unansweredChecks({ ...base, mayReadStatus: false, environmentKnown: false })).toEqual({
      status: false,
      diagnosis: false,
    });
  });

  test("running and prepared versions are both named", () => {
    const versions = workflowVersions(
      { current_version_id: "v1", current_version: 1 },
      { version_id: "v2", version: 2 },
    );
    expect([...versions]).toEqual([
      ["v1", 1],
      ["v2", 2],
    ]);
    expect(workflowVersions({ current_version_id: null, current_version: null }, null).size).toBe(
      0,
    );
  });
});

describe("run health", () => {
  test("only a reviewable repair with a digest is offered", () => {
    const ready = { id: "p2", reviewable: true, review_digest: "d" };
    expect(openRepair([{ id: "p1", reviewable: true, review_digest: null }, ready])).toBe(ready);
    expect(openRepair(undefined)).toBeNull();
  });

  test("the first step whose connector lost its sign-in is waiting", () => {
    const records = [
      { id: "c1", slug: "gmail", display_name: "Gmail", health_state: "ok" },
      { id: "c2", slug: "jira", display_name: "Jira", needs_reauth: true },
    ];
    expect(
      waitingConnectorFor(
        [
          { connectorId: "c1", connector: null },
          { connectorId: null, connector: "jira" },
        ],
        records,
      ),
    ).toEqual({ id: "c2", name: "Jira", state: "expired" });
    expect(waitingConnectorFor([{ connectorId: "c1", connector: null }], records)).toBeNull();
  });
});

describe("strip copy", () => {
  test("the headline names version, environment and runs", () => {
    expect(
      automationHeadline(
        state({
          state: "approved",
          facts: { ...state({ state: "approved" }).facts, runsLeft: 2, runsMax: 5 },
        }),
        t,
        dateTime,
      ),
    ).toBe(
      'automation.fact.version {"version":"v3"} · authority.production · automation.fact.runs {"left":2,"max":5}',
    );
    expect(automationHeadline(state({ state: "repair" }), t, dateTime)).toBe(
      "automation.headline.repairUnnamed",
    );
    expect(automationHeadline(null, t, dateTime)).toBeNull();
  });

  const line = (partial: Partial<StripLineInput> & Pick<StripLineInput, "strip">) =>
    stripLine(
      {
        state: null,
        noticed: false,
        blocked: 1,
        waitingConnector: null,
        failure: null,
        health: null,
        repairDescription: null,
        lastRun: "",
        noRecentFailures: false,
        headline: "fallback",
        ...partial,
      },
      t,
    );
  const strip = (kind: string) =>
    ({ kind, tone: "warn", action: null, lower: [] }) as unknown as StripLineInput["strip"];

  test("each strip state explains itself in one line", () => {
    expect(line({ strip: strip("loading") })).toBeNull();
    expect(line({ strip: strip("repair"), blocked: 2 })).toBe(
      'workflowStrip.line.blocked.other {"count":2}',
    );
    expect(
      line({
        strip: strip("connector"),
        waitingConnector: { id: "c1", name: "Gmail", state: "expired" },
      }),
    ).toBe('workflowStrip.line.connectorExpired {"name":"Gmail"}');
    expect(
      line({
        strip: strip("failing"),
        failure: { cause_class: "timeout", step_key: "send" },
        health: "failing",
      }),
    ).toBe('detail.cause.atStep {"step":"send","cause":"cause.timeout"}');
    expect(line({ strip: strip("approved"), lastRun: "ran", noRecentFailures: true })).toBe(
      "ran · workflowStrip.line.noRecentFailures",
    );
    expect(line({ strip: strip("expiring") })).toBe("fallback");
  });

  test("help lists lower states, the opening notice and a missing right", () => {
    const shown = workflowStrip({
      automation: null,
      failed: true,
      disabled: false,
      noSteps: false,
      health: null,
      failedRunId: null,
      repairPrepared: false,
      waitingConnector: null,
      rights: { write: false, chat: false },
    });
    expect(
      stripHelp(
        { strip: { ...shown, action: null }, notice: null, adoptable: false, canWrite: false },
        t,
      ),
    ).toEqual(["automation.noRight"]);
    expect(
      stripHelp(
        {
          strip: { ...shown, lower: ["paused"] },
          notice: "automation.opening.trial",
          adoptable: true,
          canWrite: true,
        },
        t,
      ),
    ).toEqual([
      'workflowStrip.also {"states":"workflowStrip.state.paused"}',
      "authority.review.help.adopt",
    ]);
  });
});
