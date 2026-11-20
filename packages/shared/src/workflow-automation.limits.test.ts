import { describe, expect, test } from "bun:test";
import { input } from "./workflow-automation.test-helpers.ts";
import {
  type AutomationState,
  automationActionPermitted,
  automationState,
  limitsProposable,
} from "./workflow-automation.ts";
import { type StripInput, workflowStrip } from "./workflow-strip.ts";

const diagnosis = (code: string | undefined, step_id: string, extra: object = {}) => ({
  ...(code === undefined ? {} : { code }),
  subject: { step_id },
  remedy_kind: "author",
  ...extra,
});

describe("limits SubKit can propose", () => {
  test("a missing limit, an open page count and a contradicted folder are proposable", () => {
    for (const code of [
      "no_boundary",
      "no_scope",
      "pagination_unbounded",
      "boundary_contradicted_by_history",
    ])
      expect(limitsProposable({ code })).toBe(true);
    expect(limitsProposable({ code: "runtime_header" })).toBe(false);
    expect(limitsProposable({ code: "" })).toBe(false);
    expect(limitsProposable({})).toBe(false);
  });

  test("repair with a missing limit leads with setting limits for that step", () => {
    const state = automationState(
      input({ diagnosis: { is_current: true, diagnoses: [diagnosis("no_boundary", "send")] } }),
    );
    expect(state.state).toBe("repair");
    expect(state.primaryAction).toEqual({ kind: "repair", via: "limits", stepId: "send" });
    expect(state.facts.blockedStep).toBe("send");
  });

  test("a later missing limit leads only when no other diagnosis has a repair or a trial of its own", () => {
    const state = (first: object) =>
      automationState(
        input({
          diagnosis: {
            is_current: true,
            diagnoses: [
              diagnosis("execution_authority_changed", "mail", first),
              diagnosis("no_scope", "store"),
            ],
          },
        }),
      );
    expect(state({}).primaryAction).toEqual({ kind: "repair", via: "limits", stepId: "store" });
    expect(state({ fixer: "use_utf8_encoder" }).primaryAction).toEqual({
      kind: "repair",
      via: "auto",
      stepId: "mail",
    });
    expect(state({ remedy_kind: "prepare" }).primaryAction).toEqual({
      kind: "repair",
      via: "prepare",
      stepId: "mail",
    });
  });

  test("a missing limit that comes first leads whatever follows it", () => {
    const state = automationState(
      input({
        diagnosis: {
          is_current: true,
          diagnoses: [
            diagnosis("no_boundary", "send"),
            diagnosis("execution_authority_changed", "mail", { fixer: "use_utf8_encoder" }),
            diagnosis("report_delivery_unprepared", "report", { remedy_kind: "prepare" }),
          ],
        },
      }),
    );
    expect(state.primaryAction).toEqual({ kind: "repair", via: "limits", stepId: "send" });
  });

  test("a repair that comes after other diagnoses does not hide a missing limit", () => {
    const state = automationState(
      input({
        diagnosis: {
          is_current: true,
          diagnoses: [
            diagnosis("runtime_header", "call"),
            diagnosis("no_scope", "store"),
            diagnosis("execution_authority_changed", "mail", { fixer: "use_utf8_encoder" }),
          ],
        },
      }),
    );
    expect(state.primaryAction).toEqual({ kind: "repair", via: "chat", stepId: "call" });
  });

  test("other diagnoses keep the remedy they had", () => {
    const withFixer = automationState(
      input({
        diagnosis: {
          is_current: true,
          diagnoses: [
            diagnosis("execution_authority_changed", "mail", { fixer: "use_utf8_encoder" }),
          ],
        },
      }),
    );
    expect(withFixer.primaryAction).toEqual({ kind: "repair", via: "auto", stepId: "mail" });
    const authored = automationState(
      input({ diagnosis: { is_current: true, diagnoses: [diagnosis("runtime_header", "call")] } }),
    );
    expect(authored.primaryAction).toEqual({ kind: "repair", via: "chat", stepId: "call" });
    const uncoded = automationState(
      input({ diagnosis: { is_current: true, diagnoses: [diagnosis(undefined, "old")] } }),
    );
    expect(uncoded.primaryAction).toEqual({ kind: "repair", via: "chat", stepId: "old" });
  });

  test("setting limits needs the right to change the workflow", () => {
    const action = { kind: "repair", via: "limits", stepId: "send" } as const;
    expect(automationActionPermitted(action, { write: true, run: false, chat: false })).toBe(true);
    expect(automationActionPermitted(action, { write: false, run: true, chat: true })).toBe(false);
  });
});

const strip = (overrides: Partial<StripInput>): StripInput => ({
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

const repairState = (overrides: Partial<AutomationState> = {}): AutomationState =>
  ({
    ...automationState(
      input({ diagnosis: { is_current: true, diagnoses: [diagnosis("no_boundary", "send")] } }),
    ),
    ...overrides,
  }) as AutomationState;

describe("the strip in repair", () => {
  test("carries the one action that opens the approval dialog on the limits", () => {
    expect(workflowStrip(strip({ automation: repairState() }))).toEqual({
      kind: "repair",
      tone: "warn",
      action: { kind: "approve", via: "limits" },
      lower: [],
    });
  });

  test("offers nothing without the right to write or without a version to review", () => {
    expect(
      workflowStrip(strip({ automation: repairState(), rights: { write: false, chat: true } }))
        .action,
    ).toBeNull();
    expect(workflowStrip(strip({ automation: repairState({ target: null }) })).action).toBeNull();
  });

  test("keeps every other repair without a strip action", () => {
    for (const primaryAction of [
      { kind: "repair", via: "chat", stepId: "send" },
      { kind: "repair", via: "auto", stepId: "send" },
      { kind: "repair", via: "prepare", stepId: "send" },
      { kind: "repair", via: "review", stepId: "send" },
      { kind: "view" },
      null,
    ] as const)
      expect(workflowStrip(strip({ automation: repairState({ primaryAction }) }))).toEqual({
        kind: "repair",
        tone: "warn",
        action: null,
        lower: [],
      });
  });
});
