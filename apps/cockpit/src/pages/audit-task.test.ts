import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_ROUTE_PATHS } from "@/app/route-table";
import { LOCALES, type TranslationKey, translate } from "@/lib/i18n";
import { ACCESS_TYPES } from "./audit-filter-state";
import { accessLabel } from "./audit-labels";
import {
  AUDIT_AREAS,
  auditActionLabel,
  auditAreaParams,
  auditReasonLabel,
  auditResourceHref,
  auditResourceLabel,
  auditResourcePermission,
  auditScopeParams,
  auditSearchActions,
} from "./audit-model";
import { entry } from "./audit-model-fixtures.ts";
import { auditDuration, auditTaskFacts } from "./audit-task";

const ENGINE = resolve(import.meta.dir, "../../../engine/src");
const API = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../../../../packages/cli-core/src/engine-api/openapi.json"),
    "utf8",
  ),
) as {
  components: {
    schemas: Record<string, { properties: Record<string, { enum?: (string | null)[] }> }>;
  };
};

const t =
  (locale: (typeof LOCALES)[number]) =>
  (key: TranslationKey, values?: Record<string, string | number>) =>
    translate(locale, key, values);
const de = t("de");
const dateTime = (value: string | Date) => `<${String(value)}>`;

function apiEnum(schema: string, property: string): string[] {
  const values = API.components.schemas[schema]?.properties[property]?.enum ?? [];
  return values.filter((value): value is string => typeof value === "string");
}

function engineList(file: string, name: string): string[] {
  const source = readFileSync(resolve(ENGINE, file), "utf8");
  const body = new RegExp(`export const ${name} =([^;]*);`).exec(source)?.[1] ?? "";
  return [...body.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] as string);
}

const ENGINE_ACTIONS = [
  ...readFileSync(resolve(ENGINE, "audit/types.ts"), "utf8").matchAll(
    /"((?:task|task_run)\.[a-z_.]+|tool_policy\.confirmation_skipped)"/g,
  ),
].map((match) => match[1] as string);

const REASON_CODES = {
  failure: apiEnum("TaskRun", "failure_code"),
  waiting: apiEnum("TaskRun", "waiting_reason"),
  paused: apiEnum("Task", "paused_reason"),
  admission: engineList("tasks/types.ts", "TASK_ADMISSION_REASONS"),
  sleep: engineList("tasks/core/run-state.ts", "TASK_SLEEP_REASONS"),
  revocation: [
    "revoked",
    "superseded",
    ...engineList("workflows/execution-authorities.ts", "TASK_GRANT_AUTHORITY_REVOCATION_REASONS"),
  ],
  resume: ["wake"],
  skipped: ["authority_covered"],
};

const ENGLISH_STATES: Record<string, string> = {
  completed: "done",
  waiting: "waiting for you",
  admitted: "allowed",
};
const englishState = (state: string) => ENGLISH_STATES[state] ?? state;

const UUID = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
const TASK = "018f4b4a-6d33-7b3a-9c2d-aaaaaaaaaaaa";

describe("what the engine can record about tasks has a word in both languages", () => {
  test("the vocabularies are read (a moved file must not turn this into a vacuous pass)", () => {
    expect(ENGINE_ACTIONS).toHaveLength(18);
    expect(REASON_CODES.failure).toHaveLength(11);
    expect(REASON_CODES.waiting).toHaveLength(7);
    expect(REASON_CODES.paused).toHaveLength(3);
    expect(REASON_CODES.admission).toHaveLength(8);
    expect(REASON_CODES.sleep).toHaveLength(3);
    expect(REASON_CODES.revocation).toHaveLength(7);
  });

  test("every task, task run and standing permission action is named", () => {
    for (const action of ENGINE_ACTIONS) {
      const label = auditActionLabel(action);
      expect({ action, kind: label.kind }).toEqual({ action, kind: "named" });
      if (label.kind !== "named") continue;
      for (const locale of LOCALES) expect(t(locale)(label.key).trim()).not.toBe("");
      expect(de(label.key)).not.toBe(translate("en", label.key));
    }
  });

  test("every reason code is named", () => {
    for (const [group, codes] of Object.entries(REASON_CODES))
      for (const code of codes)
        for (const locale of LOCALES)
          expect({
            group,
            code,
            locale,
            machine: auditReasonLabel(code, t(locale))?.machine,
          }).toEqual({ group, code, locale, machine: false });
  });

  test("the run states and the ways a run starts are named where an entry shows them", () => {
    const shown = (details: Record<string, string>, locale: (typeof LOCALES)[number]) =>
      auditTaskFacts({ details }, t(locale), dateTime).map((fact) => fact.value);
    for (const state of [...apiEnum("TaskRun", "state"), "held", "admitted"]) {
      expect(shown({ state }, "de")).not.toEqual([state]);
      expect(shown({ state }, "en")).toEqual([state.replace("_", " ")].map(englishState));
    }
    for (const trigger of apiEnum("TaskRun", "trigger"))
      for (const locale of LOCALES) expect(shown({ trigger }, locale)).not.toEqual([trigger]);
  });

  test("the three resource types and the access type are named", () => {
    expect(auditResourceLabel("task", de)).toEqual({ text: "Aufgabe", machine: false });
    expect(auditResourceLabel("task_run", de)).toEqual({
      text: "Lauf einer Aufgabe",
      machine: false,
    });
    expect(auditResourceLabel("task_grant", de)).toEqual({
      text: "Dauererlaubnis",
      machine: false,
    });
    expect(auditResourceLabel("task_grant", t("en")).text).toBe("Standing permission");
    expect(ACCESS_TYPES).toContain("task_run");
    expect(accessLabel("task_run", de)).toBe("Lauf einer Aufgabe");
    expect(accessLabel("task_run", t("en"))).toBe("Task run");
    expect(de("runs.caller.method.task_run")).toBe("Lauf einer Aufgabe");
  });
});

describe("a start without a question", () => {
  const skipped = entry({
    action: "tool_policy.confirmation_skipped",
    resource_type: "conversation",
    resource_id: UUID,
    reason: "authority_covered",
    details: { covering_authority_id: TASK },
  });

  test("says that an approval covers the run and names it", () => {
    const label = auditActionLabel(skipped.action);
    expect(label.kind === "named" ? de(label.key) : null).toBe(
      "Start ohne Rückfrage, weil eine Freigabe den Lauf deckt",
    );
    expect(label.kind === "named" ? translate("en", label.key) : null).toBe(
      "Started without asking because an approval covers the run",
    );
    expect(auditReasonLabel(skipped.reason, de)).toEqual({
      text: "Eine Freigabe deckt den Lauf",
      machine: false,
    });
    expect(auditTaskFacts(skipped, de, dateTime)).toEqual([
      { label: "Deckende Freigabe", value: TASK },
    ]);
    expect(auditSearchActions("ohne rückfrage", de)).toEqual(["tool_policy.confirmation_skipped"]);
  });
});

describe("the facts of a task entry", () => {
  test("an entry without task facts adds nothing", () => {
    expect(auditTaskFacts(entry({}), de, dateTime)).toEqual([]);
    expect(auditTaskFacts({ details: null }, de, dateTime)).toEqual([]);
  });

  test("a failed run reads in plain words, in a fixed order", () => {
    const failed = entry({
      action: "task_run.failed",
      resource_type: "task_run",
      resource_id: UUID,
      task_id: TASK,
      task_run_id: UUID,
      details: {
        duration_ms: 5_400_000,
        turns_used: 7,
        failure_code: "deadline_exceeded",
        previous_state: "running",
      },
    });
    expect(auditTaskFacts(failed, de, dateTime)).toEqual([
      { label: "Aufgaben-ID", value: TASK },
      { label: "Lauf-ID der Aufgabe", value: UUID },
      { label: "Zustand davor", value: "läuft" },
      { label: "Ursache", value: "Die Frist ist abgelaufen" },
      { label: "Arbeitsschritte", value: "7" },
      { label: "Dauer", value: "1 h 30 min" },
    ]);
    expect(auditTaskFacts(failed, t("en"), dateTime).slice(2)).toEqual([
      { label: "State before", value: "running" },
      { label: "Cause", value: "The time limit ran out" },
      { label: "Work steps", value: "7" },
      { label: "Duration", value: "1 h 30 min" },
    ]);
  });

  test("a standing permission shows its validity, also when it has no end", () => {
    const facts = (details: Record<string, string | number | boolean | null>) =>
      auditTaskFacts({ details }, de, dateTime);
    expect(
      facts({
        execution_environment: "prod",
        valid_until: null,
        max_runs: null,
        task_grant_id: UUID,
      }),
    ).toEqual([
      { label: "Läuft im", value: "Echtbetrieb" },
      { label: "Gültig bis", value: "Bis auf Widerruf" },
      { label: "Erlaubte Läufe", value: "Unbegrenzt" },
      { label: "ID der Dauererlaubnis", value: UUID },
    ]);
    expect(
      facts({
        execution_environment: "dev",
        valid_until: "2026-12-01T00:00:00.000Z",
        max_runs: 5,
        reserved_runs: 2,
        reason_code: "grant_exhausted",
      }),
    ).toEqual([
      { label: "Begründung", value: "Dauererlaubnis aufgebraucht" },
      { label: "Läuft im", value: "Test" },
      { label: "Gültig bis", value: "<2026-12-01T00:00:00.000Z>" },
      { label: "Erlaubte Läufe", value: "5" },
      { label: "Genutzte Läufe", value: "2" },
    ]);
  });

  test("a held start, a pause and a change read by their codes' words", () => {
    expect(
      auditTaskFacts(
        { details: { state: "held", reason_code: "previous_run_active", trigger: "cron" } },
        de,
        dateTime,
      ),
    ).toEqual([
      { label: "Start", value: "Nach Zeitplan" },
      { label: "Zustand", value: "zurückgehalten" },
      { label: "Begründung", value: "Vorheriger Lauf noch offen" },
    ]);
    expect(
      auditTaskFacts(
        {
          details: {
            paused_reason: "admin",
            previous_paused_reason: "owner_request",
            waiting_reason: "question",
            resume_reason: "check_requested",
            grant_invalidated: true,
            scheduled_for: "2026-11-20T07:00:00.000Z",
            deadline_at: "2026-11-20T11:00:00.000Z",
          },
        },
        de,
        dateTime,
      ),
    ).toEqual([
      { label: "Wartet, weil", value: "Hat eine Rückfrage" },
      { label: "Pausiert, weil", value: "Von einem Administrator pausiert" },
      { label: "War pausiert, weil", value: "Von ihrer Person pausiert" },
      { label: "Fortgesetzt nach", value: "Nächste Prüfung geplant" },
      { label: "Geplant für", value: "<2026-11-20T07:00:00.000Z>" },
      { label: "Muss fertig sein bis", value: "<2026-11-20T11:00:00.000Z>" },
      { label: "Dauererlaubnis durch die Änderung beendet", value: "Ja" },
    ]);
    expect(auditTaskFacts({ details: { grant_invalidated: false } }, t("en"), dateTime)).toEqual([
      { label: "Standing permission ended by the change", value: "No" },
    ]);
  });

  test("a value of the wrong kind is left out, an unknown code stays readable as it is", () => {
    expect(
      auditTaskFacts(
        {
          details: {
            trigger: 1,
            state: true,
            environment: 2,
            failure_code: 3,
            turns_used: "7",
            duration_ms: "long",
            scheduled_for: 4,
            valid_until: 5,
            max_runs: "many",
            grant_invalidated: "yes",
            task_grant_id: 6,
            unknown_field: "x",
          },
        },
        de,
        dateTime,
      ),
    ).toEqual([]);
    expect(
      auditTaskFacts(
        { details: { trigger: "webhook", state: "new", environment: "stage" } },
        de,
        dateTime,
      ),
    ).toEqual([
      { label: "Start", value: "webhook" },
      { label: "Zustand", value: "new" },
      { label: "Läuft im", value: "stage" },
    ]);
    expect(auditTaskFacts({ details: { failure_code: "vendor.code" } }, de, dateTime)).toEqual([
      { label: "Ursache", value: "vendor.code" },
    ]);
  });

  test("durations read in the largest fitting unit", () => {
    expect(auditDuration(0)).toBe("0 s");
    expect(auditDuration(59_400)).toBe("59 s");
    expect(auditDuration(59_600)).toBe("1 min");
    expect(auditDuration(3_540_000)).toBe("59 min");
    expect(auditDuration(3_600_000)).toBe("1 h");
    expect(auditDuration(86_400_000)).toBe("24 h");
  });
});

describe("from an entry to the task", () => {
  test("a task, its run and its standing permission all lead to the task page", () => {
    expect(auditResourceHref("task", TASK)).toBe(`/cockpit/tasks/${TASK}`);
    expect(auditResourceHref("task_run", UUID, TASK)).toBe(`/cockpit/tasks/${TASK}`);
    expect(auditResourceHref("task_grant", UUID, TASK)).toBe(`/cockpit/tasks/${TASK}`);
  });

  test("a run or permission without a recorded task gets no guessed link", () => {
    expect(auditResourceHref("task_run", UUID)).toBeNull();
    expect(auditResourceHref("task_grant", UUID, null)).toBeNull();
    expect(auditResourceHref("task", null, TASK)).toBeNull();
  });

  test("the link needs the right to read tasks; inherited names grant nothing", () => {
    for (const type of ["task", "task_run", "task_grant"])
      expect(auditResourcePermission(type)).toBe("task:read");
    expect(auditResourcePermission("workflow")).toBe("workflow:read");
    expect(auditResourcePermission("tenant")).toBeNull();
    expect(auditResourcePermission("constructor")).toBeNull();
  });

  test("the task page is a route this cockpit registers", () => {
    expect(ALL_ROUTE_PATHS).toContain("/tasks/$resourceId");
  });
});

describe("finding task entries", () => {
  test("the tasks area selects the three resource types", () => {
    expect(AUDIT_AREAS.tasks).toEqual(["task", "task_run", "task_grant"]);
    expect(auditAreaParams("tasks")).toEqual({ resource_types: "task,task_run,task_grant" });
  });

  test("giving and ending a standing permission count as decisions", () => {
    const decisions = auditScopeParams("decisions").action?.split(",") ?? [];
    expect(decisions).toContain("task.authority_granted");
    expect(decisions).toContain("task.authority_revoked");
    expect(decisions).not.toContain("task_run.started");
  });

  test("an action is found by its German or English name", () => {
    expect(auditSearchActions("dauererlaubnis", de)).toEqual([
      "task.authority_granted",
      "task.authority_revoked",
    ]);
    expect(auditSearchActions("standing permission", t("en"))).toEqual([
      "task.authority_granted",
      "task.authority_revoked",
    ]);
  });
});
