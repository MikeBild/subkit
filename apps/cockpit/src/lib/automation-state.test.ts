import { describe, expect, test } from "bun:test";
import { automationState, recommendedAutomationEnvironment } from "@/lib/automation-state";
import { CATALOGS } from "@/lib/i18n";
import {
  ACTIVE,
  authority,
  block,
  DRAFT,
  inputs,
  schedule,
  status,
} from "./automation-state-fixtures.ts";

describe("automation approval environment", () => {
  test("uses the preview recommendation when only production is possible", () => {
    expect(
      recommendedAutomationEnvironment({ recommended_environment: { environment: "prod" } }),
    ).toBe("prod");
  });

  test("leaves the previous fallback for unavailable recommendations", () => {
    expect(recommendedAutomationEnvironment(null)).toBeNull();
    expect(
      recommendedAutomationEnvironment({ recommended_environment: { environment: null } }),
    ).toBeNull();
  });
});

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
    expect(state.primaryAction).toEqual({ kind: "view" });
    expect(state.secondaryAction).toBeNull();
  });

  test("approved until revoked: no end date, no run limit, the runs so far", () => {
    const open = authority({
      valid_until: null,
      max_runs: null,
      remaining_runs: null,
      reserved_runs: 41,
      open_ended: true,
    });
    const state = automationState(inputs({ status: status(["authorized"]), authorities: [open] }));
    expect(state.state).toBe("approved");
    expect(state.facts).toMatchObject({
      validUntil: null,
      untilRevoked: true,
      runsLeft: null,
      runsMax: null,
      runsSoFar: 41,
    });
    expect(state.primaryAction).toEqual({ kind: "view" });
    expect(state.secondaryAction).toBeNull();
    expect(CATALOGS.de["automation.fact.untilRevoked"]).toBe("bis auf Widerruf");
    expect(CATALOGS.de["automation.fact.runsSoFar.other"]).toBe("{count} Läufe bisher");
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
    expect(state.primaryAction).toEqual({ kind: "grant" });
    expect(state.pendingEnvironments).toEqual(["dev"]);
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
