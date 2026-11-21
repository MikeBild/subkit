import { describe, expect, test } from "bun:test";
import {
  AUTOMATION_STATE_KEYS,
  type AutomationInputs,
  automationActionKey,
  automationActionPermitted,
  automationCard,
  automationEnvironment,
  automationEnvironmentUndecided,
  automationState,
  grantNeedsExtension,
} from "@/features/grants/model/automation-state";
import {
  authority,
  block,
  DRAFT,
  hooked,
  inputs,
  NOW,
  rows,
  schedule,
  status,
} from "@/features/grants/model/automation-state-fixtures";
import { CATALOGS } from "@/lib/i18n";

const DAY = 24 * 60 * 60 * 1000;

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

  test("never offered for an approval until revoked", () => {
    const open = { valid_until: null, remaining_runs: null, max_runs: null };
    expect(grantNeedsExtension(open, NOW)).toBe(false);
    expect(grantNeedsExtension(open, NOW + 10_000 * DAY)).toBe(false);
    expect(grantNeedsExtension({ ...open, remaining_runs: 1, max_runs: 30 }, NOW)).toBe(true);
    expect(grantNeedsExtension({ ...base, remaining_runs: null, max_runs: null }, NOW)).toBe(false);
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

describe("a workflow started only over HTTP", () => {
  const bare = (overrides: Partial<AutomationInputs> = {}) =>
    inputs({ status: null, schedules: [], authorities: [], ...overrides });

  test("is undecided without trigger, hook or approval", () => {
    expect(automationEnvironmentUndecided(bare())).toBe(true);
  });

  test("is decided by any approval, trigger or hook", () => {
    expect(automationEnvironmentUndecided(bare({ authorities: [authority()] }))).toBe(false);
    expect(automationEnvironmentUndecided(bare({ schedules: [schedule()] }))).toBe(false);
    expect(automationEnvironmentUndecided(bare({ workflow: hooked }))).toBe(false);
    expect(automationEnvironmentUndecided(bare({ authorities: null }))).toBe(false);
  });

  test("uses the environment its connectors live in", () => {
    expect(automationEnvironment(bare({ connectorEnvironment: "prod" }))).toBe("prod");
  });

  test("falls back to development without a resolved environment", () => {
    expect(automationEnvironment(bare({ connectorEnvironment: null }))).toBe("dev");
    expect(automationEnvironment(bare())).toBe("dev");
  });

  test("never overrides an approval, a trigger or a hook", () => {
    expect(
      automationEnvironment(
        bare({
          authorities: [authority({ execution_environment: "dev" })],
          connectorEnvironment: "prod",
        }),
      ),
    ).toBe("dev");
    expect(
      automationEnvironment(
        bare({ schedules: [schedule({ execution_mode: "dev" })], connectorEnvironment: "prod" }),
      ),
    ).toBe("dev");
    expect(automationEnvironment(bare({ workflow: hooked, connectorEnvironment: "dev" }))).toBe(
      "prod",
    );
  });

  test("offers the approval in the resolved environment without a repair", () => {
    const state = automationState(bare({ connectorEnvironment: "prod" }));
    expect(state.environment).toBe("prod");
    expect(state.state).toBe("manual");
    expect(state.primaryAction).toEqual({ kind: "grant" });
    expect(state.pendingEnvironments).toEqual(["prod"]);
  });

  test("still shows the repair state when the diagnosis blocks a step", () => {
    const state = automationState(
      bare({
        connectorEnvironment: null,
        diagnosis: { is_current: true, diagnoses: [block({ code: "environment_mismatch" })] },
      }),
    );
    expect(state.state).toBe("repair");
    expect(state.environment).toBe("dev");
  });
});

describe("actions", () => {
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
  const approved = { status: status(["authorized"]), authorities: [authority()] };

  test("the diagnosis did not answer, and an approval exists", () => {
    const state = automationState(
      inputs({ ...approved, diagnosis: null, unanswered: { status: false, diagnosis: true } }),
    );
    expect(state.state).toBe("unknown");
    expect(state.primaryAction).toBeNull();
    expect(state.secondaryAction).toEqual({ kind: "view" });
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
    const state = automationState(inputs({ authorities: [authority()], status: null }));
    expect(state.state).toBe("approved");
  });

  test("what is known without the read still outranks it", () => {
    const paused = automationState(
      inputs({
        schedules: [schedule({ paused: true })],
        status: null,
        unanswered: { status: true, diagnosis: true },
      }),
    );
    expect(paused.state).toBe("paused");
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
    expect(automationEnvironment(input)).toBe("dev");
    const state = automationState(input);
    expect(state.state).toBe("grant");
    expect(state.environment).toBe("dev");
    expect(state.pendingEnvironments).toEqual(["dev"]);
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
    expect(state.state).toBe("approved");
    const manual = automationState(
      inputs({
        schedules: [],
        status: status(),
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
