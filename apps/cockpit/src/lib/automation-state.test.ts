import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AUTOMATION_STATE_KEYS,
  type AutomationInputs,
  type AutomationRowState,
  type AutomationStatusLike,
  automationActionKey,
  automationActionPermitted,
  automationCard,
  automationEnvironment,
  automationNeedsMoreApprovals,
  automationState,
  automationTitleAction,
  EXTEND_BELOW_RUN_SHARE,
  EXTEND_WITHIN_DAYS,
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
    unanswered: { status: false, diagnosis: false },
    now: NOW,
    ...overrides,
  };
}

/** Verified schedule rows that each name their own environment. */
function rows(
  entries: ReadonlyArray<readonly [AutomationRowState, "dev" | "prod"]>,
): AutomationStatusLike {
  return {
    schedules: entries.map(([state, environment], index) => ({
      schedule_id: `schedule-${index + 1}`,
      state,
      cron: "0 7 * * *",
      timezone: "Europe/Berlin",
      environment,
      next_run_at: null,
    })),
    inbound_hooks: [],
  };
}

const hooked = {
  lifecycle: "active",
  current_version_id: ACTIVE,
  draft_version_id: ACTIVE,
  current_version: 9,
  webhooks_active: 1,
};

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

  test("when no read of the schedules answered, nothing is claimed", () => {
    const state = automationState(inputs({ ...unverified, schedules: null }));
    expect(state.state).toBe("unknown");
    expect(state.primaryAction).toBeNull();
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

describe("triggers", () => {
  test("a schedule only the list knows still counts", () => {
    const state = automationState(
      inputs({ status: status(), schedules: [schedule({ id: "late" })], authorities: [] }),
    );
    expect(state.triggers.map((trigger) => trigger.id)).toEqual(["late"]);
    expect(state.state).toBe("grant");
  });

  test("a schedule both reads know is listed once, with the verified facts", () => {
    const state = automationState(inputs({ schedules: [schedule({ cron: "stale" })] }));
    expect(state.triggers).toHaveLength(1);
    expect(state.triggers[0]?.cron).toBe("0 7 * * *");
  });

  test("a paused schedule in the list is paused, whatever the row says", () => {
    const state = automationState(
      inputs({ status: status(["approval_required"]), schedules: [schedule({ paused: true })] }),
    );
    expect(state.triggers[0]?.paused).toBe(true);
    expect(state.state).toBe("paused");
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

  test("the chat card has a title and a line for every state, in both languages", () => {
    const states = [
      inputs({ status: status(["authorized"]), authorities: [authority()] }),
      inputs(),
      inputs({ status: status(["repair_required"]), diagnosis: null }),
      inputs({ workflow: { ...hooked, draft_version_id: DRAFT } }),
      inputs({ schedules: [schedule({ paused: true })], status: status(["paused"]) }),
      inputs({ schedules: [], status: status() }),
      inputs({ authorities: null }),
    ].map((input) => automationState(input));
    expect(new Set(states.map((state) => state.state)).size).toBe(7);
    for (const state of states) {
      const card = automationCard(state, 0);
      for (const catalog of Object.values(CATALOGS))
        for (const key of [card.titleKey, card.hintKey, card.actionKey])
          expect(catalog[key], `${state.state}: ${key}`).toBeTruthy();
    }
  });
});

describe("a read that did not answer is never read as approved", () => {
  // Each of these used to say "approved": a failed read left `null` behind,
  // and `null` meant "nothing to report".
  const approved = { status: status(["authorized"]), authorities: [authority()] };

  test("the diagnosis did not answer, and an approval exists", () => {
    const state = automationState(
      inputs({ ...approved, diagnosis: null, unanswered: { status: false, diagnosis: true } }),
    );
    expect(state.state).toBe("unknown");
    expect(state.primaryAction).toBeNull();
    // The approval that exists stays one press away.
    expect(state.secondaryAction).toEqual({ kind: "view" });
    expect(automationTitleAction(state)).toBeNull();
  });

  test("the verified status errored, and an approval exists", () => {
    const state = automationState(
      inputs({
        authorities: [authority()],
        status: null,
        unanswered: { status: true, diagnosis: false },
      }),
    );
    expect(state.state).toBe("unknown");
    expect(state.grant).toBeNull();
  });

  test("a status the reader may not ask for is not a failed one", () => {
    // Without `schedule:read` the state is decided from what remains.
    const state = automationState(inputs({ authorities: [authority()], status: null }));
    expect(state.state).toBe("approved");
  });

  test("what is known without the read still outranks it", () => {
    // Paused and a waiting change are read from the record and the schedules.
    const paused = automationState(
      inputs({
        schedules: [schedule({ paused: true })],
        status: null,
        unanswered: { status: true, diagnosis: true },
      }),
    );
    expect(paused.state).toBe("paused");
    // A refusal the status itself reports is a repair, whatever the diagnosis read did.
    const refused = automationState(
      inputs({
        status: status(["repair_required"]),
        diagnosis: null,
        unanswered: { status: false, diagnosis: true },
      }),
    );
    expect(refused.state).toBe("repair");
  });
});

describe("schedules in both environments", () => {
  test("the environment that still waits is named — not production by default", () => {
    const input = inputs({
      schedules: [
        schedule({ id: "schedule-1", execution_mode: "prod" }),
        schedule({ id: "schedule-2", execution_mode: "dev" }),
      ],
      status: rows([
        ["authorized", "prod"],
        ["approval_required", "dev"],
      ]),
      authorities: [authority()],
    });
    // The diagnosis and the approval dialog are asked for the half that waits.
    expect(automationEnvironment(input)).toBe("dev");
    const state = automationState(input);
    expect(state.state).toBe("grant");
    expect(state.environment).toBe("dev");
    expect(state.pendingEnvironments).toEqual(["dev"]);
    // Production's approval is not the one this state rests on, and stays reachable.
    expect(state.grant).toBeNull();
    expect(state.alsoValid.map((entry) => entry.execution_environment)).toEqual(["prod"]);
    expect(state.secondaryAction).toEqual({ kind: "view" });
  });

  test("both waiting: both are pending, production first", () => {
    const state = automationState(
      inputs({
        status: rows([
          ["approval_required", "dev"],
          ["approval_required", "prod"],
        ]),
      }),
    );
    expect(state.environment).toBe("prod");
    expect(state.pendingEnvironments).toEqual(["prod", "dev"]);
  });

  test("without verified rows, every environment something starts it in needs an approval", () => {
    const both = [
      schedule({ id: "a", execution_mode: "prod" }),
      schedule({ id: "b", execution_mode: "dev" }),
    ];
    const state = automationState(
      inputs({ status: null, schedules: both, authorities: [authority()] }),
    );
    // Production is approved; development is not — that is not "approved".
    expect(state.state).toBe("grant");
    expect(state.environment).toBe("dev");
    const dev = authority({
      id: "00000000-0000-4000-8000-0000000000a2",
      execution_environment: "dev",
    });
    expect(
      automationState(inputs({ status: null, schedules: both, authorities: [authority(), dev] }))
        .state,
    ).toBe("approved");
  });
});

describe("an approval that is still valid is never out of reach", () => {
  const dev = authority({
    id: "00000000-0000-4000-8000-0000000000a2",
    execution_environment: "dev",
  });

  test("approval needed here, one valid elsewhere: it can be viewed and revoked", () => {
    const state = automationState(
      inputs({ status: status(["approval_required"]), authorities: [dev] }),
    );
    expect(state.state).toBe("grant");
    expect(state.alsoValid).toEqual([dev]);
    expect(state.primaryAction).toEqual({ kind: "grant" });
    expect(state.secondaryAction).toEqual({ kind: "view" });
  });

  test("not verified: the valid approvals are still listed and viewable", () => {
    const state = automationState(
      inputs({ status: status(["verification_unavailable"]), authorities: [authority(), dev] }),
    );
    expect(state.state).toBe("unknown");
    expect(state.alsoValid).toHaveLength(2);
    expect(state.secondaryAction).toEqual({ kind: "view" });
  });

  test("on request, with an approval for another environment", () => {
    const state = automationState(
      inputs({ schedules: [], status: status(), authorities: [authority()], workflow: hooked }),
    );
    // The hook runs in production and production is approved.
    expect(state.state).toBe("approved");
    const manual = automationState(
      inputs({
        schedules: [],
        status: status(),
        // Lapsed approvals name production as where it belongs; the valid one is for development.
        authorities: [authority({ state: "expired", ready_for_new_run: false }), dev],
      }),
    );
    expect(manual.state).toBe("manual");
    expect(manual.environment).toBe("prod");
    expect(manual.alsoValid).toEqual([dev]);
    expect(manual.secondaryAction).toEqual({ kind: "view" });
  });

  test("nothing valid: no view action is offered", () => {
    expect(automationState(inputs()).secondaryAction).toBeNull();
  });
});

describe("a hook the reader may not list", () => {
  test("authorized development schedules do not answer for it", () => {
    const input = inputs({
      workflow: hooked,
      schedules: [schedule({ execution_mode: "dev" })],
      status: rows([["authorized", "dev"]]),
    });
    // No approval for production in the list: the hook has none.
    const none = automationState(input);
    expect(none.state).toBe("grant");
    expect(none.environment).toBe("prod");
    // One in the list that no row confirms: not verified, never "approved".
    const listed = automationState({ ...input, authorities: [authority()] });
    expect(listed.state).toBe("unknown");
    expect(listed.secondaryAction).toEqual({ kind: "view" });
  });

  test("an authorized production schedule answers for it: same version, same approval", () => {
    const state = automationState(
      inputs({
        workflow: hooked,
        status: rows([["authorized", "prod"]]),
        authorities: [authority()],
      }),
    );
    expect(state.state).toBe("approved");
  });
});

describe("the approval in force can lie behind the first page", () => {
  test("approved without its approval in sight asks for more", () => {
    const state = automationState(inputs({ status: status(["authorized"]), authorities: [] }));
    expect(state.state).toBe("approved");
    expect(state.grant).toBeNull();
    expect(automationNeedsMoreApprovals(state, true)).toBe(true);
    // Nothing further to read: the state stands as it is.
    expect(automationNeedsMoreApprovals(state, false)).toBe(false);
  });

  test("an approval in sight, or any other state, asks for nothing", () => {
    const approved = automationState(
      inputs({ status: status(["authorized"]), authorities: [authority()] }),
    );
    expect(automationNeedsMoreApprovals(approved, true)).toBe(false);
    expect(automationNeedsMoreApprovals(automationState(inputs()), true)).toBe(false);
  });
});

describe("a stopped hook cannot be resumed from here", () => {
  test("a hook-only workflow that is paused offers no action", () => {
    const state = automationState(
      inputs({ schedules: [], status: status([], ["paused"]), workflow: hooked }),
    );
    expect(state.state).toBe("paused");
    // The panel says so in one line instead of a button that does nothing.
    expect(state.primaryAction).toBeNull();
    expect(state.pendingEnvironments).toEqual([]);
  });
});

describe("the chat's review card", () => {
  const hookOnly = { schedules: [], workflow: hooked };

  test("one environment gives one button, named for the page's own step", () => {
    const card = automationCard(automationState(inputs()), 0);
    expect(card.environments).toEqual(["prod"]);
    expect(card.actionKey).toBe(automationActionKey({ kind: "grant" }));
    const apply = automationCard(
      automationState(
        inputs({
          workflow: {
            lifecycle: "active",
            current_version_id: ACTIVE,
            draft_version_id: DRAFT,
            current_version: 9,
          },
        }),
      ),
      0,
    );
    expect(apply.environments).toEqual(["prod"]);
    expect(apply.actionKey).toBe(automationActionKey({ kind: "apply" }));
    expect(apply.hintKey).toBe("chat.automationCard.apply.hint");
  });

  test("two environments give two buttons, production first", () => {
    const card = automationCard(
      automationState(
        inputs({
          status: rows([
            ["approval_required", "dev"],
            ["approval_required", "prod"],
          ]),
        }),
      ),
      0,
    );
    expect(card.environments).toEqual(["prod", "dev"]);
  });

  test("a hook-started workflow only ever offers production", () => {
    // Verified, unverified, and with a saved change: the hook runs in production.
    const cards = [
      inputs({ ...hookOnly, status: status([], ["approval_required"]) }),
      inputs({ ...hookOnly, status: null }),
      inputs({
        ...hookOnly,
        status: status([], ["approval_required"]),
        workflow: { ...hooked, draft_version_id: DRAFT },
      }),
    ].map((input) => automationCard(automationState(input), 1));
    for (const card of cards) expect(card.environments).toEqual(["prod"]);
  });

  test("the hint names what an approval allows: scheduled runs, webhook calls, or both", () => {
    const hint = (input: Partial<AutomationInputs>, webhooks: number) =>
      automationCard(automationState(inputs(input)), webhooks).hintKey;
    expect(hint({}, 0)).toBe("chat.automationCard.review.hint.schedule");
    expect(hint({ ...hookOnly, status: status([], ["approval_required"]) }, 1)).toBe(
      "chat.automationCard.review.hint.hook",
    );
    expect(
      hint({ workflow: hooked, status: status(["approval_required"], ["approval_required"]) }, 1),
    ).toBe("chat.automationCard.review.hint.any");
    // A hook the reader may not list still counts.
    expect(hint({ ...hookOnly, status: null }, 1)).toBe("chat.automationCard.review.hint.hook");
  });

  test("an approved workflow offers no button", () => {
    const card = automationCard(
      automationState(inputs({ status: status(["authorized"]), authorities: [authority()] })),
      0,
    );
    expect(card).toMatchObject({ act: "none", environments: [] });
    expect(card.titleKey).toBe("chat.automationCard.authorized.title");
    expect(card.hintKey).toBe("chat.automationCard.authorized.hint");
  });

  test("repair opens the review under its own words", () => {
    const repair = automationCard(
      automationState(inputs({ status: status(["repair_required"]), diagnosis: null })),
      0,
    );
    expect(repair).toMatchObject({ act: "review", environments: ["prod"] });
    expect(repair.actionKey).toBe("chat.automationCard.repair.action");
  });

  // The states the page offers no approval for: the card must not either. Each
  // of these used to get a button that opened the approval dialog.
  test("on request: the page's calm state, and nothing to press", () => {
    const manual = automationCard(
      automationState(inputs({ schedules: [], status: status(), authorities: [] })),
      0,
    );
    expect(manual).toMatchObject({ act: "none", environments: [] });
    expect(manual.titleKey).toBe(AUTOMATION_STATE_KEYS.manual);
    expect(manual.hintKey).toBe("automation.headline.manual");
    const inactive = automationCard(
      automationState(
        inputs({
          workflow: {
            lifecycle: "archived",
            current_version_id: ACTIVE,
            draft_version_id: ACTIVE,
            current_version: 9,
          },
        }),
      ),
      0,
    );
    expect(inactive).toMatchObject({ act: "none", hintKey: "automation.headline.inactive" });
  });

  test("paused: resuming is the act, as on the page — or a line, for a stopped hook", () => {
    const paused = automationCard(
      automationState(
        inputs({ schedules: [schedule({ paused: true })], status: status(["paused"]) }),
      ),
      0,
    );
    expect(paused).toMatchObject({ act: "resume", environments: [] });
    expect(paused.titleKey).toBe(AUTOMATION_STATE_KEYS.paused);
    expect(paused.actionKey).toBe(automationActionKey({ kind: "resume", scheduleIds: [] }));
    const hookOff = automationCard(
      automationState(inputs({ schedules: [], status: status([], ["paused"]), workflow: hooked })),
      0,
    );
    expect(hookOff).toMatchObject({ act: "none", hintKey: "automation.hookOff" });
  });

  test("not verified: reading again is the act, never the approval dialog", () => {
    const unknown = automationCard(automationState(inputs({ authorities: null })), 0);
    expect(unknown).toMatchObject({ act: "recheck", environments: [] });
    expect(unknown.actionKey).toBe("automation.action.recheck");
    expect(unknown.hintKey).toBe("automation.headline.unknown");
  });

  test("only a pending decision opens the approval", () => {
    const acts = (
      [
        [inputs(), "review"],
        [inputs({ status: status(["authorized"]), authorities: [authority()] }), "none"],
        [inputs({ schedules: [], status: status() }), "none"],
        [inputs({ authorities: null }), "recheck"],
      ] as const
    ).map(([input, act]) => [automationCard(automationState(input), 0).act, act]);
    for (const [actual, expected] of acts) expect(actual).toBe(expected);
  });

  test("every word of the card exists in both catalogs", () => {
    const keys = [
      "chat.automationCard.review.hint.schedule",
      "chat.automationCard.review.hint.hook",
      "chat.automationCard.review.hint.any",
      "chat.automationCard.review.prod",
      "chat.automationCard.review.dev",
      "chat.automationCard.repair.action",
    ] as const;
    for (const catalog of Object.values(CATALOGS))
      for (const key of keys) expect(catalog[key], key).toBeTruthy();
    // The card says to OPEN the review; its content is not "below".
    for (const key of keys.slice(0, 3)) {
      expect(CATALOGS.de[key]).toStartWith("Öffne die Prüfung");
      expect(CATALOGS.de[key]).not.toContain("unten");
    }
    expect(CATALOGS.de["chat.automationCard.review.hint.schedule"]).toContain("geplante Läufe");
    expect(CATALOGS.de["chat.automationCard.review.hint.hook"]).toContain(
      "eingehende Webhook-Aufrufe",
    );
  });
});

describe("the extension thresholds are the engine's", () => {
  test("the attention list and the panel warn on the same numbers", () => {
    const engine = readFileSync(
      new URL("../../../engine/src/workflows/authority-extension.ts", import.meta.url).pathname,
      "utf8",
    );
    const constant = (name: string) => {
      const match = new RegExp(`export const ${name} = ([0-9.]+);`).exec(engine);
      if (!match?.[1]) throw new Error(`${name} not found in the engine`);
      return Number(match[1]);
    };
    expect(EXTEND_WITHIN_DAYS).toBe(constant("AUTHORITY_EXTEND_WITHIN_DAYS"));
    expect(EXTEND_BELOW_RUN_SHARE).toBe(constant("AUTHORITY_EXTEND_BELOW_RUN_SHARE"));
  });
});
