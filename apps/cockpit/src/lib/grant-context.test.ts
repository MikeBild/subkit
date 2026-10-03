import { describe, expect, test } from "bun:test";
import {
  existingGrant,
  grantOpeningNotice,
  grantScopeWarnings,
  hookStartedOnly,
  OPENING_NOTICE_KEYS,
  suggestionNote,
  triggerEnvironments,
} from "@/lib/grant-context";
import { CATALOGS, interpolate } from "@/lib/i18n";
import type { WorkflowAuthority } from "@/lib/workflow-authorities";

const WORKFLOW = "00000000-0000-4000-8000-000000000002";
const ACTIVE = "00000000-0000-4000-8000-000000000003";
const DRAFT = "00000000-0000-4000-8000-000000000013";
const NOW = Date.parse("2030-03-10T12:00:00.000Z");

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
    open_ended: false,
    inherited_from: null,
    superseded_by: null,
    active_version: true,
    ready_for_new_run: true,
    state: "approved",
    ...overrides,
  };
}

describe("an approval that already covers what is reviewed", () => {
  test("is found for the same version in the same environment", () => {
    const current = authority();
    expect(existingGrant([current], ACTIVE, "prod", NOW)).toBe(current);
  });

  test("the dialog's header says until when and how many runs are left", () => {
    const current = existingGrant([authority()], ACTIVE, "prod", NOW);
    expect(
      interpolate(CATALOGS.de["authority.existing.title"], {
        until: "30.03.2030, 01:00",
        runs: current?.remaining_runs ?? 0,
      }),
    ).toBe("Bereits freigegeben bis 30.03.2030, 01:00 · 28 Läufe übrig");
    expect(CATALOGS.de["authority.existing.titleOne"]).toContain("1 Lauf übrig");
    // The further approval is named for what it is — never the first one again.
    expect(CATALOGS.de["authority.existing.confirm"]).toBe("Verlängern / Grenzen ändern");
    expect(CATALOGS.en["authority.existing.confirm"]).toBe("Extend / change limits");
  });

  test("is not one for another environment or another version", () => {
    expect(existingGrant([authority()], ACTIVE, "dev", NOW)).toBeNull();
    expect(existingGrant([authority()], DRAFT, "prod", NOW)).toBeNull();
  });

  test("is not one that no longer admits a run", () => {
    const gone = [
      authority({ state: "revoked", revoked_at: "2030-03-02T00:00:00.000Z" }),
      authority({ valid_until: "2030-03-10T11:00:00.000Z" }),
      authority({ remaining_runs: 0, reserved_runs: 30 }),
      authority({ state: "invalidated", ready_for_new_run: false }),
      authority({ active_version: false }),
    ];
    for (const entry of gone) expect(existingGrant([entry], ACTIVE, "prod", NOW)).toBeNull();
  });

  test("an unread list is no approval", () => {
    expect(existingGrant(null, ACTIVE, "prod", NOW)).toBeNull();
    expect(existingGrant(undefined, ACTIVE, "prod", NOW)).toBeNull();
  });
});

describe("where the workflow is started", () => {
  test("a hook always counts as production; a paused schedule does not count", () => {
    expect(triggerEnvironments([{ execution_mode: "dev", paused: false }], 1)).toEqual([
      "prod",
      "dev",
    ]);
    expect(triggerEnvironments([{ execution_mode: "prod", paused: true }], 0)).toEqual([]);
    expect(triggerEnvironments(null, 2)).toEqual(["prod"]);
    expect(triggerEnvironments(null, null)).toEqual([]);
  });
});

describe("the scope of an approval", () => {
  const base = { startedIn: ["prod"] as const, savedChange: false, activeVersion: 9 };

  test("approving development while it is started in production is said", () => {
    expect(grantScopeWarnings({ ...base, environment: "dev" })).toEqual([
      { kind: "other_environment", selected: "dev", runsIn: "prod" },
    ]);
  });

  test("the ordinary case says nothing", () => {
    expect(grantScopeWarnings({ ...base, environment: "prod" })).toEqual([]);
    // Started in both: either environment is one it runs in.
    expect(grantScopeWarnings({ ...base, startedIn: ["prod", "dev"], environment: "dev" })).toEqual(
      [],
    );
    // Nothing starts it automatically: there is no "wrong" environment.
    expect(grantScopeWarnings({ ...base, startedIn: [], environment: "dev" })).toEqual([]);
  });

  test("approving a saved change names the version that runs today", () => {
    expect(grantScopeWarnings({ ...base, environment: "prod", savedChange: true })).toEqual([
      { kind: "saved_change", active: 9 },
    ]);
    expect(
      grantScopeWarnings({ ...base, environment: "dev", savedChange: true, activeVersion: null }),
    ).toEqual([
      { kind: "other_environment", selected: "dev", runsIn: "prod" },
      { kind: "saved_change", active: null },
    ]);
  });
});

describe("what opening the dialog sets off", () => {
  const prepare = [{ remedy_kind: "prepare" as const }];

  test("a trial run, when the gate still has to see what a step sends", () => {
    expect(grantOpeningNotice({ diagnoses: prepare, hookStarted: false, mayRun: true })).toBe(
      "trial",
    );
  });

  test("a sample call, when only a hook starts it", () => {
    expect(grantOpeningNotice({ diagnoses: prepare, hookStarted: true, mayRun: true })).toBe(
      "sample",
    );
  });

  test("nothing, when opening only shows the review", () => {
    expect(grantOpeningNotice({ diagnoses: [], hookStarted: true, mayRun: true })).toBeNull();
    expect(grantOpeningNotice({ diagnoses: null, hookStarted: false, mayRun: true })).toBeNull();
    expect(
      grantOpeningNotice({
        diagnoses: [{ remedy_kind: "author" }, { remedy_kind: "patch" }],
        hookStarted: false,
        mayRun: true,
      }),
    ).toBeNull();
    // Without the right to run, the dialog starts nothing.
    expect(
      grantOpeningNotice({ diagnoses: prepare, hookStarted: false, mayRun: false }),
    ).toBeNull();
  });

  test("only a hook starts it: no running schedule supplies an input", () => {
    const hook = { kind: "hook" as const, paused: false };
    const schedule = { kind: "schedule" as const, paused: false };
    expect(hookStartedOnly([hook], 1)).toBe(true);
    expect(hookStartedOnly([hook, schedule], 1)).toBe(false);
    expect(hookStartedOnly([hook, { ...schedule, paused: true }], 1)).toBe(true);
    // A hook the reader may not list is known by the record's count.
    expect(hookStartedOnly([], 2)).toBe(true);
    expect(hookStartedOnly([], 0)).toBe(false);
  });

  test("each notice is one short sentence in both languages", () => {
    for (const catalog of Object.values(CATALOGS))
      for (const key of Object.values(OPENING_NOTICE_KEYS)) {
        expect(catalog[key]).toBeTruthy();
        expect(catalog[key].split(". ").length).toBe(1);
      }
  });
});

describe("where the suggested limits come from", () => {
  test("a hook's suggestion names its calls and the days they were counted over", () => {
    expect(
      suggestionNote({
        kind: "hook",
        scheduled_runs: 0,
        observed_deliveries: 140,
        observed_days: 14,
        minimum_applied: false,
      }),
    ).toEqual({ key: "authority.suggestion.hook", values: { count: 140, days: 14 } });
  });

  test("the floor is said as the floor", () => {
    expect(
      suggestionNote({
        kind: "hook",
        scheduled_runs: 0,
        observed_deliveries: 2,
        observed_days: 14,
        minimum_applied: true,
      })?.key,
    ).toBe("authority.suggestion.hookMinimum");
  });

  test("no call at all is not counted as 'only 0 calls'", () => {
    const note = suggestionNote({
      kind: "hook",
      scheduled_runs: 0,
      observed_deliveries: 0,
      observed_days: 14,
      minimum_applied: true,
    });
    expect(note).toEqual({ key: "authority.suggestion.hookNone", values: { days: 14 } });
    const text = interpolate(CATALOGS.de["authority.suggestion.hookNone"], note?.values ?? {});
    expect(text).not.toContain("0");
    expect(text).toContain("kein Webhook-Aufruf");
  });

  test("a schedule says so; the one-run default needs no line", () => {
    expect(suggestionNote({ kind: "schedule", scheduled_runs: 30 })?.key).toBe(
      "authority.suggestion.schedule",
    );
    expect(suggestionNote({ kind: "manual" })).toBeNull();
    expect(suggestionNote(undefined)).toBeNull();
  });
});
