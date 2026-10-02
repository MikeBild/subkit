import { describe, expect, test } from "bun:test";
import {
  AUTOMATION_STATE_KEYS,
  type AutomationInputs,
  type AutomationRowState,
  type AutomationStatusLike,
  automationActionKey,
  automationActionPermitted,
  automationEnvironment,
  automationState,
  automationSummary,
  automationTitleAction,
  grantNeedsExtension,
  type ScheduleLike,
} from "@/lib/automation-state";
import { CATALOGS } from "@/lib/i18n";
import type { WorkflowAuthority } from "@/lib/workflow-authorities";

const WORKFLOW = "00000000-0000-4000-8000-000000000002";
const ACTIVE = "00000000-0000-4000-8000-000000000003";
const DRAFT = "00000000-0000-4000-8000-000000000013";
const NOW = Date.parse("2030-03-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function authority(overrides: Partial<WorkflowAuthority> = {}): WorkflowAuthority {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workflow_id: WORKFLOW,
    workflow_version_id: ACTIVE,
    effect_manifest_digest: "digest",
    effect_manifest: {
      schema_version: 1,
      tenant_id: "00000000-0000-4000-8000-000000000004",
      workflow_id: WORKFLOW,
      workflow_version_id: ACTIVE,
      workflow_digest: "workflow",
      execution_environment: "prod",
      execution_options_digest: "options",
      effects: [],
      issues: [],
    },
    execution_environment: "prod",
    target_constraints: { targets: [] },
    valid_from: "2030-03-01T00:00:00.000Z",
    valid_until: "2030-03-30T00:00:00.000Z",
    max_runs: 30,
    reserved_runs: 2,
    remaining_runs: 28,
    created_by: "00000000-0000-4000-8000-000000000005",
    created_at: "2030-03-01T00:00:00.000Z",
    revoked_at: null,
    revoked_by: null,
    active_version: true,
    ready_for_new_run: true,
    state: "approved",
    ...overrides,
  };
}

const schedule = (overrides: Partial<ScheduleLike> = {}): ScheduleLike => ({
  id: "schedule-1",
  cron: "0 7 * * *",
  timezone: "Europe/Berlin",
  execution_mode: "prod",
  paused: false,
  ...overrides,
});

function status(
  schedules: AutomationRowState[] = [],
  hooks: AutomationRowState[] = [],
): AutomationStatusLike {
  return {
    schedules: schedules.map((state, index) => ({
      schedule_id: `schedule-${index + 1}`,
      state,
      cron: "0 7 * * *",
      timezone: "Europe/Berlin",
      environment: "prod",
      next_run_at: null,
    })),
    inbound_hooks: hooks.map((state, index) => ({
      inbound_hook_id: `hook-${index + 1}`,
      slug: `hook-${index + 1}`,
      state,
      environment: "prod",
    })),
  };
}

const block = (overrides: Record<string, unknown> = {}) =>
  ({
    code: "report_inspection_missing",
    subject: { step_id: "send_email" },
    evidence: {},
    remedy_kind: "author",
    ...overrides,
  }) as NonNullable<AutomationInputs["diagnosis"]>["diagnoses"][number];

function inputs(overrides: Partial<AutomationInputs> = {}): AutomationInputs {
  return {
    workflow: {
      lifecycle: "active",
      current_version_id: ACTIVE,
      draft_version_id: ACTIVE,
      current_version: 9,
      webhooks_active: 0,
    },
    draft: null,
    schedules: [schedule()],
    status: status(["approval_required"]),
    authorities: [],
    diagnosis: { is_current: true, diagnoses: [] },
    now: NOW,
    ...overrides,
  };
}

describe("automationState — one state, by precedence", () => {
  test("approved: a current approval covers the running version", () => {
    const state = automationState(
      inputs({ status: status(["authorized"]), authorities: [authority()] }),
    );
    expect(state.state).toBe("approved");
    expect(state.environment).toBe("prod");
    expect(state.facts).toMatchObject({
      version: 9,
      validUntil: "2030-03-30T00:00:00.000Z",
      runsLeft: 28,
      runsMax: 30,
    });
    expect(state.grant?.id).toBe(authority().id);
    // No approval button once approved: only the way to look at it.
    expect(state.primaryAction).toEqual({ kind: "view" });
    expect(state.secondaryAction).toBeNull();
  });

  test("grant: something starts it and no approval covers it", () => {
    const state = automationState(inputs());
    expect(state.state).toBe("grant");
    expect(state.primaryAction).toEqual({ kind: "grant" });
    expect(state.grant).toBeNull();
    expect(state.target).toMatchObject({ kind: "active", version_id: ACTIVE, version: 9 });
  });

  test("repair outranks an existing approval — the newest approved run was refused", () => {
    const state = automationState(
      inputs({
        status: status(["authorized"]),
        authorities: [authority()],
        diagnosis: {
          is_current: true,
          diagnoses: [block({ code: "execution_authority_changed" })],
        },
      }),
    );
    expect(state.state).toBe("repair");
    expect(state.facts.blockedStep).toBe("send_email");
    // The approval is still shown: it exists, it just no longer fits.
    expect(state.grant?.id).toBe(authority().id);
    expect(state.secondaryAction).toEqual({ kind: "view" });
  });

  test("repair takes its act from the first block", () => {
    const of = (entry: Record<string, unknown>, isCurrent = true) =>
      automationState(inputs({ diagnosis: { is_current: isCurrent, diagnoses: [block(entry)] } }))
        .primaryAction;
    expect(of({ fixer: "bind_report_delivery", remedy_kind: "patch" })).toEqual({
      kind: "repair",
      via: "auto",
      stepId: "send_email",
    });
    expect(
      of({
        fixer: "bind_report_delivery",
        remedy_kind: "patch",
        candidate_id: "00000000-0000-4000-8000-0000000000c1",
      }),
    ).toEqual({ kind: "repair", via: "review", stepId: "send_email" });
    expect(of({ remedy_kind: "prepare" })).toEqual({
      kind: "repair",
      via: "prepare",
      stepId: "send_email",
    });
    expect(of({ remedy_kind: "author" })).toEqual({
      kind: "repair",
      via: "chat",
      stepId: "send_email",
    });
    expect(of({ remedy_kind: "reconnect" })).toEqual({
      kind: "repair",
      via: "chat",
      stepId: "send_email",
    });
  });

  test("repair without a named block: the engine reports a refusal the diagnosis cannot explain", () => {
    for (const row of ["repair_required", "input_required"] as const) {
      const state = automationState(inputs({ status: status([row]), diagnosis: null }));
      expect(state.state).toBe("repair");
      expect(state.primaryAction).toEqual({ kind: "repair", via: "chat", stepId: null });
    }
  });

  test("apply outranks repair: a saved change differs from the running version", () => {
    const state = automationState(
      inputs({
        workflow: {
          lifecycle: "active",
          current_version_id: ACTIVE,
          draft_version_id: DRAFT,
          current_version: 9,
        },
        draft: { version_id: DRAFT, version: 10 },
        // A draft's diagnosis describes the draft; it never makes this "repair".
        diagnosis: { is_current: false, diagnoses: [block({ fixer: "bind_report_delivery" })] },
        authorities: [authority()],
        status: status(["authorized"]),
      }),
    );
    expect(state.state).toBe("apply");
    expect(state.facts.preparedVersion).toBe(10);
    expect(state.primaryAction).toEqual({ kind: "apply" });
    expect(state.target).toMatchObject({
      kind: "prepared",
      version_id: DRAFT,
      activation: { expected_current_version_id: ACTIVE },
    });
  });

  test("paused outranks everything: every schedule and hook is stopped", () => {
    const state = automationState(
      inputs({
        workflow: {
          lifecycle: "active",
          current_version_id: ACTIVE,
          draft_version_id: DRAFT,
          current_version: 9,
        },
        schedules: [schedule({ paused: true })],
        status: status(["paused"], ["paused"]),
        diagnosis: { is_current: true, diagnoses: [block()] },
      }),
    );
    expect(state.state).toBe("paused");
    expect(state.primaryAction).toEqual({ kind: "resume", scheduleIds: ["schedule-1"] });
  });

  test("a paused schedule does not hide an active hook that needs approval", () => {
    const state = automationState(
      inputs({
        schedules: [schedule({ paused: true })],
        status: status(["paused"], ["approval_required"]),
        workflow: {
          lifecycle: "active",
          current_version_id: ACTIVE,
          draft_version_id: ACTIVE,
          current_version: 9,
          webhooks_active: 1,
        },
      }),
    );
    expect(state.state).toBe("grant");
    expect(state.environment).toBe("prod");
  });

  test("a stopped hook alone is paused, with nothing to resume from here", () => {
    const state = automationState(inputs({ schedules: [], status: status([], ["paused"]) }));
    expect(state.state).toBe("paused");
    expect(state.primaryAction).toBeNull();
  });

  test("unknown: readiness that could not be verified is never read as approved", () => {
    expect(
      automationState(
        inputs({ status: status(["verification_unavailable"]), authorities: [authority()] }),
      ).state,
    ).toBe("unknown");
    const unread = automationState(inputs({ authorities: null }));
    expect(unread.state).toBe("unknown");
    expect(unread.primaryAction).toBeNull();
  });

  test("manual: nothing starts it automatically — a calm state, not a task", () => {
    const state = automationState(inputs({ schedules: [], status: status(), authorities: [] }));
    expect(state.state).toBe("manual");
    expect(state.facts.inactive).toBe(false);
    // The approval is offered, but nothing asks for it beside the title.
    expect(state.primaryAction).toEqual({ kind: "grant" });
    expect(automationTitleAction(state)).toBeNull();
  });

  test("a manual workflow with a current approval is approved", () => {
    const state = automationState(
      inputs({ schedules: [], status: status(), authorities: [authority()] }),
    );
    expect(state.state).toBe("approved");
  });

  test("a workflow without a running version is inactive, not waiting for approval", () => {
    const state = automationState(
      inputs({
        workflow: {
          lifecycle: "archived",
          current_version_id: ACTIVE,
          draft_version_id: ACTIVE,
          current_version: 9,
        },
        status: status(["activation_required"]),
      }),
    );
    expect(state.state).toBe("manual");
    expect(state.facts.inactive).toBe(true);
    expect(state.primaryAction).toBeNull();
  });
});

describe("automationState — without the verified status", () => {
  const unverified = { status: null };

  test("a schedule without an approval needs one", () => {
    expect(automationState(inputs(unverified)).state).toBe("grant");
  });

  test("a schedule with a current approval reads as approved", () => {
    expect(automationState(inputs({ ...unverified, authorities: [authority()] })).state).toBe(
      "approved",
    );
  });

  test("hooks the reader may not list still count as automation", () => {
    const state = automationState(
      inputs({
        ...unverified,
        schedules: [],
        workflow: {
          lifecycle: "active",
          current_version_id: ACTIVE,
          draft_version_id: ACTIVE,
          current_version: 9,
          webhooks_active: 2,
        },
      }),
    );
    expect(state.state).toBe("grant");
    expect(state.environment).toBe("prod");
  });

  test("a failed read of the schedules is not the calm manual state when hooks exist", () => {
    const state = automationState(
      inputs({
        ...unverified,
        schedules: null,
        workflow: {
          lifecycle: "active",
          current_version_id: ACTIVE,
          draft_version_id: ACTIVE,
          current_version: 9,
          webhooks_active: 1,
        },
      }),
    );
    expect(state.state).not.toBe("manual");
  });
});

describe("the engine's verified answer decides", () => {
  test("an approval in the list that the status does not confirm is not the current one", () => {
    const state = automationState(
      inputs({ status: status(["approval_required"]), authorities: [authority()] }),
    );
    expect(state.state).toBe("grant");
    expect(state.grant).toBeNull();
    // It is still listed — once.
    expect(state.alsoValid).toHaveLength(1);
    expect(state.history).toHaveLength(0);
  });

  test("an approval the server has invalidated never counts", () => {
    const state = automationState(
      inputs({
        status: null,
        authorities: [authority({ state: "invalidated", ready_for_new_run: false })],
      }),
    );
    expect(state.state).toBe("grant");
    expect(state.history).toHaveLength(1);
  });

  test("the local clock may narrow an approval, never extend it", () => {
    const expired = authority({ valid_until: "2030-03-10T11:59:00.000Z" });
    const state = automationState(inputs({ status: null, authorities: [expired] }));
    expect(state.state).toBe("grant");
    expect(state.history).toEqual([expired]);
  });
});

describe("approvals are listed exactly once", () => {
  test("the current one, the others a run could use, and the history", () => {
    const current = authority();
    const dev = authority({
      id: "00000000-0000-4000-8000-0000000000a2",
      execution_environment: "dev",
    });
    const revoked = authority({
      id: "00000000-0000-4000-8000-0000000000a3",
      state: "revoked",
      revoked_at: "2030-03-02T00:00:00.000Z",
      ready_for_new_run: false,
    });
    const old = authority({
      id: "00000000-0000-4000-8000-0000000000a4",
      active_version: false,
      ready_for_new_run: false,
    });
    const state = automationState(
      inputs({ status: status(["authorized"]), authorities: [current, dev, revoked, old] }),
    );
    expect(state.grant).toBe(current);
    expect(state.alsoValid).toEqual([dev]);
    expect(state.history).toEqual([revoked, old]);
  });
});

describe("extending an approval", () => {
  const base = { valid_until: "2030-03-30T00:00:00.000Z", remaining_runs: 28, max_runs: 30 };

  test("offered inside three days of its end", () => {
    expect(grantNeedsExtension(base, NOW)).toBe(false);
    expect(grantNeedsExtension(base, Date.parse(base.valid_until) - 3 * DAY)).toBe(false);
    expect(grantNeedsExtension(base, Date.parse(base.valid_until) - 3 * DAY + 1)).toBe(true);
  });

  test("offered below a tenth of its runs", () => {
    expect(grantNeedsExtension({ ...base, remaining_runs: 3 }, NOW)).toBe(false);
    expect(grantNeedsExtension({ ...base, remaining_runs: 2 }, NOW)).toBe(true);
  });

  test("an approval running out carries the extension as its second action", () => {
    const state = automationState(
      inputs({
        status: status(["authorized"]),
        authorities: [authority({ remaining_runs: 1, reserved_runs: 29 })],
      }),
    );
    expect(state.state).toBe("approved");
    expect(state.primaryAction).toEqual({ kind: "view" });
    expect(state.secondaryAction).toEqual({ kind: "extend" });
  });
});

describe("automationEnvironment", () => {
  test("a hook always runs in production", () => {
    expect(
      automationEnvironment(
        inputs({
          schedules: [schedule({ execution_mode: "dev" })],
          status: {
            ...status([], ["approval_required"]),
            schedules: [
              {
                schedule_id: "schedule-1",
                state: "approval_required",
                cron: "0 7 * * *",
                timezone: "UTC",
                environment: "dev",
                next_run_at: null,
              },
            ],
          },
        }),
      ),
    ).toBe("prod");
  });

  test("a schedule names its own environment", () => {
    expect(
      automationEnvironment(
        inputs({ status: null, schedules: [schedule({ execution_mode: "dev" })] }),
      ),
    ).toBe("dev");
  });

  test("a running trigger decides before a paused one", () => {
    expect(
      automationEnvironment(
        inputs({
          status: null,
          schedules: [
            schedule({ id: "a", execution_mode: "prod", paused: true }),
            schedule({ id: "b", execution_mode: "dev" }),
          ],
        }),
      ),
    ).toBe("dev");
  });

  test("without a trigger, the approvals say where the workflow belongs", () => {
    expect(
      automationEnvironment(inputs({ status: null, schedules: [], authorities: [authority()] })),
    ).toBe("prod");
    expect(automationEnvironment(inputs({ status: null, schedules: [], authorities: [] }))).toBe(
      "dev",
    );
  });
});

describe("actions", () => {
  test("the title carries the pending step, and nothing in a calm state", () => {
    expect(automationTitleAction(automationState(inputs()))).toEqual({ kind: "grant" });
    expect(
      automationTitleAction(
        automationState(inputs({ status: status(["authorized"]), authorities: [authority()] })),
      ),
    ).toBeNull();
    expect(automationTitleAction(automationState(inputs({ authorities: null })))).toBeNull();
  });

  test("an action is offered only to someone who may perform it", () => {
    const none = { write: false, run: false, chat: false };
    expect(automationActionPermitted({ kind: "view" }, none)).toBe(true);
    for (const kind of ["apply", "grant", "extend"] as const) {
      expect(automationActionPermitted({ kind }, none)).toBe(false);
      expect(automationActionPermitted({ kind }, { ...none, write: true })).toBe(true);
    }
    expect(automationActionPermitted({ kind: "resume", scheduleIds: [] }, none)).toBe(false);
    const repair = (via: "review" | "auto" | "prepare" | "chat") =>
      ({ kind: "repair", via, stepId: "a" }) as const;
    expect(automationActionPermitted(repair("auto"), { ...none, write: true })).toBe(true);
    expect(automationActionPermitted(repair("review"), { ...none, run: true })).toBe(false);
    expect(automationActionPermitted(repair("prepare"), { ...none, run: true })).toBe(true);
    expect(automationActionPermitted(repair("chat"), { ...none, chat: true })).toBe(true);
    expect(automationActionPermitted(repair("chat"), { ...none, write: true })).toBe(false);
  });

  test("every state and every action has a word in both catalogs", () => {
    const keys = [
      ...Object.values(AUTOMATION_STATE_KEYS),
      automationActionKey({ kind: "resume", scheduleIds: [] }),
      automationActionKey({ kind: "apply" }),
      automationActionKey({ kind: "grant" }),
      automationActionKey({ kind: "extend" }),
      automationActionKey({ kind: "view" }),
      ...(["review", "auto", "prepare", "chat"] as const).map((via) =>
        automationActionKey({ kind: "repair", via, stepId: null }),
      ),
    ];
    for (const key of keys) {
      expect(CATALOGS.en[key], key).toBeTruthy();
      expect(CATALOGS.de[key], key).toBeTruthy();
    }
    // The approved state never offers approving again under another name.
    expect(CATALOGS.de[automationActionKey({ kind: "view" })]).toBe("Freigabe ansehen");
    expect(CATALOGS.de[automationActionKey({ kind: "grant" })]).toBe("Jetzt freigeben");
  });

  test("the chat card's vocabulary maps onto the same states", () => {
    expect(automationSummary("approved")).toBe("authorized");
    expect(automationSummary("repair")).toBe("repair");
    expect(automationSummary("grant")).toBe("review");
    expect(automationSummary("apply")).toBe("apply");
    for (const state of ["paused", "manual", "unknown"] as const)
      expect(automationSummary(state)).toBe("unknown");
  });
});
