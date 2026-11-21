import { describe, expect, test } from "bun:test";
import type { AutomationState } from "./workflow-automation.ts";
import { deletedConnectorReference, type StripInput, workflowStrip } from "./workflow-strip.ts";

const input = (overrides: Partial<StripInput> = {}): StripInput => ({
  automation: null,
  failed: false,
  disabled: false,
  health: null,
  failedRunId: null,
  repairPrepared: false,
  waitingConnector: null,
  rights: { write: true, chat: true },
  ...overrides,
});

const state = (overrides: Partial<AutomationState> = {}): AutomationState =>
  ({
    state: "manual",
    environment: "dev",
    target: null,
    facts: {
      version: null,
      preparedVersion: null,
      validUntil: null,
      runsLeft: null,
      runsMax: null,
      runsSoFar: null,
      untilRevoked: false,
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
  }) as AutomationState;

describe("workflowStrip", () => {
  test("healthy and reauthentication-only automation retain the complete calm strip", () => {
    for (const kind of ["manual", "approved"] as const)
      for (const health of [null, "ok", "needs_reauth"])
        expect(workflowStrip(input({ automation: state({ state: kind }), health }))).toEqual({
          kind,
          tone: "ok",
          action: null,
          lower: [],
        });
  });

  test("paused automation without a resume action remains paused without an action", () => {
    expect(
      workflowStrip(input({ automation: state({ state: "paused", primaryAction: null }) })),
    ).toEqual({
      kind: "paused",
      tone: "warn",
      action: null,
      lower: [],
    });
  });
  test("uses terminal failures and empty/loading states before automation candidates", () => {
    expect(workflowStrip(input({ failed: true }))).toEqual({
      kind: "failed",
      tone: "error",
      action: { kind: "retry" },
      lower: [],
    });
    expect(workflowStrip(input({ noSteps: true }))).toEqual({
      kind: "empty",
      tone: "info",
      action: { kind: "addStep" },
      lower: [],
    });
    expect(
      workflowStrip(input({ noSteps: true, rights: { write: false, chat: true } })).action,
    ).toBeNull();
    expect(workflowStrip(input())).toEqual({
      kind: "loading",
      tone: "ok",
      action: null,
      lower: [],
    });
  });

  test("orders candidate states and preserves actions", () => {
    const strip = workflowStrip(
      input({
        automation: state({
          state: "paused",
          target: { kind: "active", version_id: "v", version: 1, active_version: 1 },
          primaryAction: { kind: "resume", scheduleIds: ["s"] },
        }),
        disabled: true,
        waitingConnector: { id: "c", name: "C", state: "missing" },
        health: "failing",
        failedRunId: "run",
        repairPrepared: true,
      }),
    );
    expect(strip).toMatchObject({ kind: "disabled", action: { kind: "enable" } });
    expect(strip.lower).toEqual(["connector", "failing", "repairPrepared"]);
  });

  test("maps every automation action family and calm states", () => {
    expect(
      workflowStrip(
        input({
          automation: state({
            state: "paused",
            primaryAction: { kind: "resume", scheduleIds: ["s"] },
          }),
        }),
      ),
    ).toMatchObject({ kind: "paused", action: { kind: "resume", scheduleIds: ["s"] } });
    expect(workflowStrip(input({ automation: state({ state: "invalid" }) }))).toMatchObject({
      kind: "invalid",
      action: { kind: "chat" },
    });
    expect(workflowStrip(input({ automation: state({ state: "repair" }) }))).toMatchObject({
      kind: "repair",
    });
    expect(
      workflowStrip(
        input({
          automation: state({
            state: "grant",
            target: { kind: "active", version_id: "v", version: 1, active_version: 1 },
            history: [{}] as never[],
          }),
        }),
      ),
    ).toMatchObject({ kind: "stopped", action: { kind: "approve", via: "grant" } });
    expect(
      workflowStrip(
        input({
          automation: state({
            state: "apply",
            target: { kind: "active", version_id: "v", version: 1, active_version: 1 },
          }),
        }),
      ),
    ).toMatchObject({ kind: "apply", action: { kind: "approve", via: "apply" } });
    expect(workflowStrip(input({ automation: state({ state: "unknown" }) }))).toMatchObject({
      kind: "unknown",
      action: { kind: "recheck" },
    });
    expect(
      workflowStrip(
        input({
          automation: state({
            state: "manual",
            target: { kind: "active", version_id: "v", version: 1, active_version: 1 },
            primaryAction: { kind: "grant" },
          }),
        }),
      ),
    ).toMatchObject({ kind: "unapproved", action: { kind: "approve", via: "grant" } });
    expect(
      workflowStrip(
        input({
          automation: state({
            state: "approved",
            target: { kind: "active", version_id: "v", version: 1, active_version: 1 },
            secondaryAction: { kind: "extend" },
          }),
        }),
      ),
    ).toMatchObject({ kind: "expiring", action: { kind: "approve", via: "extend" } });
    expect(workflowStrip(input({ automation: state({ state: "approved" }) }))).toMatchObject({
      kind: "approved",
    });
    expect(workflowStrip(input({ automation: state({ state: "manual" }) }))).toMatchObject({
      kind: "manual",
    });
  });

  test("keeps each visible tone and denied action distinct", () => {
    const target = { kind: "active", version_id: "v", version: 1, active_version: 1 } as const;
    const cases: Array<[string, StripInput, { kind: string; tone: string; action: unknown }]> = [
      [
        "failed",
        input({ failed: true }),
        { kind: "failed", tone: "error", action: { kind: "retry" } },
      ],
      [
        "empty",
        input({ noSteps: true }),
        { kind: "empty", tone: "info", action: { kind: "addStep" } },
      ],
      ["loading", input(), { kind: "loading", tone: "ok", action: null }],
      [
        "disabled",
        input({ disabled: true, rights: { write: false, chat: false } }),
        { kind: "disabled", tone: "warn", action: null },
      ],
      [
        "repair",
        input({ automation: state({ state: "repair" }) }),
        { kind: "repair", tone: "warn", action: null },
      ],
      [
        "unknown",
        input({ automation: state({ state: "unknown" }) }),
        { kind: "unknown", tone: "warn", action: { kind: "recheck" } },
      ],
      [
        "approved",
        input({ automation: state({ state: "approved" }) }),
        { kind: "approved", tone: "ok", action: null },
      ],
    ];
    for (const [name, value, expected] of cases) {
      expect(workflowStrip(value), name).toMatchObject(expected);
    }
    expect(
      workflowStrip(
        input({
          automation: state({ state: "apply", target }),
          rights: { write: false, chat: false },
        }),
      ),
    ).toMatchObject({ kind: "apply", tone: "warn", action: null });
    expect(
      workflowStrip(
        input({ automation: state({ state: "invalid" }), rights: { write: false, chat: false } }),
      ),
    ).toMatchObject({ kind: "invalid", tone: "error", action: null });
  });

  test("does not treat disabled empty workflows as empty and protects inactive grants", () => {
    expect(workflowStrip(input({ noSteps: true, disabled: true }))).toMatchObject({
      kind: "disabled",
      lower: [],
    });
    expect(
      workflowStrip(
        input({
          automation: state({
            state: "manual",
            primaryAction: { kind: "grant" },
            facts: { ...state().facts, inactive: true },
          }),
        }),
      ),
    ).toMatchObject({ kind: "manual", action: null });
  });

  test("assigns the declared tone to every candidate and preserves lower priority candidates", () => {
    const target = { kind: "active", version_id: "v", version: 1, active_version: 1 } as const;
    const cases: Array<[StripInput, string, string]> = [
      [
        input({
          automation: state({ state: "grant", history: [] }),
          rights: { write: false, chat: false },
        }),
        "unapproved",
        "info",
      ],
      [
        input({
          automation: state({ state: "grant", history: [{}] as never[] }),
          rights: { write: false, chat: false },
        }),
        "stopped",
        "error",
      ],
      [
        input({ waitingConnector: { id: "c", name: "C", state: "missing" }, automation: state() }),
        "connector",
        "warn",
      ],
      [input({ automation: state(), health: "broken", failedRunId: "r" }), "failing", "error"],
      [
        input({
          automation: state({ state: "approved", target, primaryAction: { kind: "extend" } }),
        }),
        "expiring",
        "warn",
      ],
      [input({ automation: state(), repairPrepared: true }), "repairPrepared", "info"],
    ];
    for (const [value, kind, tone] of cases)
      expect(workflowStrip(value)).toMatchObject({ kind, tone });
    expect(
      workflowStrip(
        input({
          automation: state(),
          waitingConnector: { id: "c", name: "C", state: "missing" },
          health: "broken",
          failedRunId: "r",
          repairPrepared: true,
        }),
      ),
    ).toMatchObject({
      kind: "connector",
      lower: ["failing", "repairPrepared"],
    });
  });

  test("handles connector, resume, health, and review boundaries without inventing actions", () => {
    expect(
      workflowStrip(
        input({ waitingConnector: { id: null, name: "C", state: "missing" }, automation: state() }),
      ),
    ).toEqual({
      kind: "connector",
      tone: "warn",
      action: null,
      lower: [],
    });
    expect(
      workflowStrip(
        input({
          waitingConnector: { id: "c", name: "C", state: "deleted" },
          automation: state(),
          rights: { write: false, chat: true },
        }),
      ),
    ).toEqual({
      kind: "connector",
      tone: "warn",
      action: { kind: "chat" },
      lower: [],
    });
    expect(
      workflowStrip(
        input({
          automation: state({ state: "paused", primaryAction: { kind: "grant" } }),
          rights: { write: true, chat: true },
        }),
      ),
    ).toEqual({
      kind: "paused",
      tone: "warn",
      action: null,
      lower: [],
    });
    expect(
      workflowStrip(
        input({
          automation: state({
            state: "paused",
            primaryAction: { kind: "resume", scheduleIds: ["a", "b"] },
          }),
          rights: { write: false, chat: true },
        }),
      ),
    ).toEqual({
      kind: "paused",
      tone: "warn",
      action: null,
      lower: [],
    });
    expect(
      workflowStrip(input({ automation: state(), health: "needs_reauth", failedRunId: "r" })),
    ).toEqual({
      kind: "manual",
      tone: "ok",
      action: null,
      lower: [],
    });
    expect(
      workflowStrip(
        input({ automation: state(), health: "broken", failedRunId: null, repairPrepared: true }),
      ),
    ).toEqual({
      kind: "failing",
      tone: "error",
      action: null,
      lower: ["repairPrepared"],
    });
  });

  test("keeps the complete strip contract for every independently visible candidate", () => {
    const target = { kind: "active", version_id: "v", version: 1, active_version: 1 } as const;
    const cases: Array<[StripInput, ReturnType<typeof workflowStrip>]> = [
      [
        input({ automation: state({ state: "invalid" }), rights: { write: false, chat: true } }),
        { kind: "invalid", tone: "error", action: { kind: "chat" }, lower: [] },
      ],
      [
        input({ disabled: true, rights: { write: true, chat: false } }),
        { kind: "disabled", tone: "warn", action: { kind: "enable" }, lower: [] },
      ],
      [
        input({ automation: state({ state: "repair" }) }),
        { kind: "repair", tone: "warn", action: null, lower: [] },
      ],
      [
        input({ automation: state({ state: "grant", history: [] }) }),
        { kind: "unapproved", tone: "info", action: null, lower: [] },
      ],
      [
        input({ automation: state({ state: "grant", history: [{}] as never[], target }) }),
        { kind: "stopped", tone: "error", action: { kind: "approve", via: "grant" }, lower: [] },
      ],
      [
        input({ automation: state({ state: "apply", target }) }),
        { kind: "apply", tone: "warn", action: { kind: "approve", via: "apply" }, lower: [] },
      ],
      [
        input({ automation: state({ state: "unknown" }) }),
        { kind: "unknown", tone: "warn", action: { kind: "recheck" }, lower: [] },
      ],
      [
        input({
          automation: state(),
          waitingConnector: { id: "connector", name: "C", state: "missing" },
        }),
        {
          kind: "connector",
          tone: "warn",
          action: { kind: "connector", connectorId: "connector" },
          lower: [],
        },
      ],
      [
        input({ automation: state(), health: "broken", failedRunId: "run" }),
        { kind: "failing", tone: "error", action: { kind: "cause", runId: "run" }, lower: [] },
      ],
      [
        input({
          automation: state({ state: "approved", target, primaryAction: { kind: "extend" } }),
        }),
        { kind: "expiring", tone: "warn", action: { kind: "approve", via: "extend" }, lower: [] },
      ],
      [
        input({ automation: state(), repairPrepared: true }),
        { kind: "repairPrepared", tone: "info", action: { kind: "review" }, lower: [] },
      ],
    ];
    for (const [value, expected] of cases) expect(workflowStrip(value)).toEqual(expected);
  });
});

describe("deletedConnectorReference", () => {
  test("nullish items and callable objects cannot become deleted connector references", () => {
    const callable = Object.assign(() => undefined, { reason: "deleted", connector_id: "c" });
    Object.defineProperty(callable, "name", { value: "Removed" });
    for (const item of [null, undefined, 0, true, "deleted", callable])
      expect(deletedConnectorReference([item])).toBeNull();
  });
  test("extracts the first valid deleted connector reference", () => {
    expect(deletedConnectorReference(null)).toBeNull();
    expect(deletedConnectorReference([{ reason: "deleted", name: " " }])).toBeNull();
    expect(
      deletedConnectorReference([
        { reason: "missing", name: "x" },
        { reason: "deleted", name: "Removed", connector_id: "c" },
      ]),
    ).toEqual({ id: "c", name: "Removed", state: "deleted" });
    expect(
      deletedConnectorReference([{ reason: "deleted", name: "Removed", connector_id: 4 }]),
    ).toEqual({ id: null, name: "Removed", state: "deleted" });
  });

  test("requires an object with a nonblank deleted name", () => {
    for (const value of [
      undefined,
      "deleted",
      0,
      false,
      {},
      [{ reason: "deleted" }],
      [{ name: "x" }],
    ]) {
      expect(deletedConnectorReference(value)).toBeNull();
    }
  });
});
