import { describe, expect, test } from "bun:test";
import type { Task } from "../engine-client/tasks.ts";
import {
  describeFlagIssues,
  describeTaskFileIssues,
  parseTaskFile,
  scheduleFromFlags,
  taskDefinitionOf,
  taskUpdateBody,
} from "./task-file-model.ts";

const WORKFLOW = "10000000-0000-4000-8000-000000000001";
const CONNECTOR = "10000000-0000-4000-8000-000000000002";

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Chase invoices",
    goal: "Remind customers of open invoices",
    done_when: "Every open invoice has a reminder",
    plan: {
      title: "Chase invoices",
      goal: "Remind customers of open invoices",
      steps: [
        {
          id: "confirm-result",
          label: "Confirm the result",
          criterion: {
            kind: "human_confirmation",
            question: "Is this done: Remind customers of open invoices?",
          },
          depends_on: [],
          evidence_ids: [],
          note: null,
          progress: "open",
          next_action: null,
        },
      ],
      cancelled: false,
      completion_step_id: "confirm-result",
    },
    bindings: {
      workflow_ids: [WORKFLOW],
      connector_ids: [CONNECTOR],
      skill_slugs: ["invoice-tone"],
      web_search: false,
    },
    environment: "prod",
    ...overrides,
  };
}

function issuesOf(overrides: Record<string, unknown>): string[] {
  const result = parseTaskFile(JSON.stringify(definition(overrides)));
  if (result.ok) return [];
  return result.issues.map((issue) => `${issue.field} ${issue.problem}`);
}

function fixOf(overrides: Record<string, unknown>): string {
  const result = parseTaskFile(JSON.stringify(definition(overrides)));
  return result.ok ? "" : (result.issues[0]?.fix ?? "");
}

const plan = definition().plan as Record<string, unknown>;
const step = (plan.steps as Record<string, unknown>[])[0] as Record<string, unknown>;
const bindings = definition().bindings as Record<string, unknown>;

describe("task file", () => {
  test("a complete definition passes unchanged and carries no revision", () => {
    const result = parseTaskFile(JSON.stringify(definition()));
    expect(result).toEqual({
      ok: true,
      definition: definition() as never,
      expected_revision: null,
    });
  });

  test("optional fields are kept when present", () => {
    const full = definition({
      description: "Weekdays",
      category: "finance",
      schedule_cron: "0 7 * * 1-5",
      schedule_timezone: "Europe/Berlin",
      schedule_run_at: null,
      max_turns: 30,
      run_deadline_minutes: 60,
    });
    const result = parseTaskFile(JSON.stringify(full));
    expect(result.ok && result.definition).toEqual(full as never);
  });

  test("a file exported by get drops the read-only fields and keeps the revision", () => {
    const exported = definition({
      id: WORKFLOW,
      owner_id: CONNECTOR,
      fingerprint: "a".repeat(64),
      revision: 4,
      lifecycle: "active",
      last_claimed_at: null,
      paused_at: null,
      paused_by: null,
      paused_reason: null,
      created_at: "2026-11-01T08:00:00.000Z",
      updated_at: "2026-11-01T08:00:00.000Z",
      latest_run: null,
      standing_permission: null,
      cockpit_url: "https://engine.test/cockpit/tasks/x",
    });
    const result = parseTaskFile(JSON.stringify(exported));
    expect(result).toEqual({ ok: true, definition: definition() as never, expected_revision: 4 });
  });

  test("an explicit expected_revision wins over an exported revision", () => {
    const result = parseTaskFile(JSON.stringify(definition({ revision: 4, expected_revision: 6 })));
    expect(result.ok && result.expected_revision).toBe(6);
  });

  test("a revision that is not a positive whole number names its field", () => {
    expect(issuesOf({ expected_revision: 0 })).toEqual([
      "expected_revision must be a whole number of at least 1",
    ]);
    expect(issuesOf({ revision: "4" })).toEqual(["revision must be a whole number of at least 1"]);
    expect(issuesOf({ expected_revision: 1.5 })).toHaveLength(1);
  });

  test("broken JSON and a non-object are reported for the file", () => {
    const broken = parseTaskFile("{");
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.issues[0]?.field).toBe("(file)");
    expect(!broken.ok && broken.issues[0]?.problem).toStartWith("is not valid JSON: ");
    for (const content of ["[]", "null", '"task"']) {
      const result = parseTaskFile(content);
      expect(!result.ok && result.issues[0]?.problem).toBe("does not contain a JSON object");
    }
  });

  test("an unknown field is named and the fix is to remove it", () => {
    expect(issuesOf({ owner: "me" })).toEqual(["owner is not a known field"]);
    expect(fixOf({ owner: "me" })).toBe("remove it");
  });

  test("required texts must be present and within their length", () => {
    expect(issuesOf({ name: undefined })).toEqual(["name is missing or empty"]);
    expect(issuesOf({ name: "  " })).toEqual(["name is missing or empty"]);
    expect(issuesOf({ name: 7 })).toEqual(["name is missing or empty"]);
    expect(issuesOf({ name: "n".repeat(201) })).toEqual(["name is longer than 200 characters"]);
    expect(issuesOf({ name: `${"n".repeat(200)}  ` })).toEqual([]);
    expect(issuesOf({ goal: "g".repeat(601) })).toEqual(["goal is longer than 600 characters"]);
    expect(issuesOf({ done_when: "" })).toEqual(["done_when is missing or empty"]);
    expect(issuesOf({ done_when: "d".repeat(2001) })).toEqual([
      "done_when is longer than 2000 characters",
    ]);
    expect(fixOf({ goal: undefined })).toBe('set "goal" to a text of at most 600 characters');
    expect(fixOf({ goal: "g".repeat(601) })).toBe("shorten it to 600 characters or less");
  });

  test("description and category are optional but checked", () => {
    expect(issuesOf({ description: null })).toEqual([]);
    expect(issuesOf({ description: "d".repeat(2000) })).toEqual([]);
    expect(issuesOf({ description: "d".repeat(2001) })).toEqual([
      "description must be a text of at most 2000 characters",
    ]);
    expect(issuesOf({ description: 3 })).toHaveLength(1);
    expect(issuesOf({ category: "finance-ops" })).toEqual([]);
    expect(issuesOf({ category: "Finance" })).toEqual(["category is not a valid category"]);
    expect(issuesOf({ category: "c".repeat(41) })).toHaveLength(1);
    expect(issuesOf({ category: 4 })).toHaveLength(1);
  });

  test("environment must be dev or prod", () => {
    expect(issuesOf({ environment: "dev" })).toEqual([]);
    expect(issuesOf({ environment: "stage" })).toEqual(['environment must be "dev" or "prod"']);
  });

  test("limits must be whole numbers inside their range", () => {
    expect(issuesOf({ max_turns: 1, run_deadline_minutes: 10080 })).toEqual([]);
    expect(issuesOf({ max_turns: 100, run_deadline_minutes: 5 })).toEqual([]);
    expect(issuesOf({ max_turns: 0 })).toEqual(["max_turns must be a whole number from 1 to 100"]);
    expect(issuesOf({ max_turns: 101 })).toHaveLength(1);
    expect(issuesOf({ max_turns: 2.5 })).toHaveLength(1);
    expect(issuesOf({ max_turns: "20" })).toHaveLength(1);
    expect(issuesOf({ run_deadline_minutes: 4 })).toEqual([
      "run_deadline_minutes must be a whole number from 5 to 10080",
    ]);
    expect(issuesOf({ run_deadline_minutes: 10081 })).toHaveLength(1);
  });
});

describe("task file plan", () => {
  test("the plan must be an object", () => {
    expect(issuesOf({ plan: undefined })).toEqual(["plan is missing or not an object"]);
    expect(issuesOf({ plan: [] })).toEqual(["plan is missing or not an object"]);
  });

  test("title, goal, cancelled and completion step are checked", () => {
    expect(issuesOf({ plan: { ...plan, title: "" } })).toEqual(["plan.title is missing or empty"]);
    expect(issuesOf({ plan: { ...plan, goal: 1 } })).toEqual(["plan.goal is missing or empty"]);
    expect(issuesOf({ plan: { ...plan, cancelled: "no" } })).toEqual([
      "plan.cancelled is missing or not true or false",
    ]);
    expect(issuesOf({ plan: { ...plan, completion_step_id: null } })).toEqual([]);
    expect(issuesOf({ plan: { ...plan, completion_step_id: undefined } })).toEqual([
      "plan.completion_step_id is missing",
    ]);
    expect(issuesOf({ plan: { ...plan, completion_step_id: 3 } })).toHaveLength(1);
  });

  test("steps must be a list of 1 to 20", () => {
    const message = ["plan.steps must be a list of 1 to 20 steps"];
    expect(issuesOf({ plan: { ...plan, steps: "none" } })).toEqual(message);
    expect(issuesOf({ plan: { ...plan, steps: [] } })).toEqual(message);
    expect(issuesOf({ plan: { ...plan, steps: Array.from({ length: 21 }, () => step) } })).toEqual(
      message,
    );
    expect(issuesOf({ plan: { ...plan, steps: Array.from({ length: 20 }, () => step) } })).toEqual(
      [],
    );
  });

  test("each step names its position", () => {
    expect(issuesOf({ plan: { ...plan, steps: [step, "second"] } })).toEqual([
      "plan.steps[1] is not an object",
    ]);
    expect(issuesOf({ plan: { ...plan, steps: [{ ...step, id: "Confirm" }] } })).toEqual([
      "plan.steps[0].id is missing or not a valid step id",
    ]);
    expect(issuesOf({ plan: { ...plan, steps: [{ ...step, id: 1 }] } })).toHaveLength(1);
    expect(issuesOf({ plan: { ...plan, steps: [{ ...step, label: "" }] } })).toEqual([
      "plan.steps[0].label is missing or empty",
    ]);
    expect(issuesOf({ plan: { ...plan, steps: [{ ...step, criterion: null }] } })).toEqual([
      "plan.steps[0].criterion.kind is missing or unknown",
    ]);
    expect(
      issuesOf({ plan: { ...plan, steps: [{ ...step, criterion: { kind: "guess" } }] } }),
    ).toHaveLength(1);
    expect(
      issuesOf({ plan: { ...plan, steps: [{ ...step, criterion: { kind: 1 } }] } }),
    ).toHaveLength(1);
  });
});

describe("task file bindings", () => {
  test("bindings must be an object with known fields", () => {
    expect(issuesOf({ bindings: undefined })).toEqual(["bindings is missing or not an object"]);
    expect(issuesOf({ bindings: { ...bindings, tools: [] } })).toEqual([
      "bindings.tools is not a known field",
    ]);
  });

  test("lists must be lists of texts, distinct and at most 20", () => {
    expect(issuesOf({ bindings: { ...bindings, workflow_ids: undefined } })).toEqual([
      "bindings.workflow_ids is missing or not a list of texts",
    ]);
    expect(issuesOf({ bindings: { ...bindings, skill_slugs: [1] } })).toHaveLength(1);
    expect(issuesOf({ bindings: { ...bindings, skill_slugs: [""] } })).toHaveLength(1);
    expect(issuesOf({ bindings: { ...bindings, skill_slugs: ["a", "a"] } })).toEqual([
      "bindings.skill_slugs names an entry twice",
    ]);
    const many = Array.from({ length: 21 }, (_, index) => `skill-${index}`);
    expect(issuesOf({ bindings: { ...bindings, skill_slugs: many } })).toEqual([
      "bindings.skill_slugs has more than 20 entries",
    ]);
    expect(issuesOf({ bindings: { ...bindings, skill_slugs: many.slice(0, 20) } })).toEqual([]);
    expect(issuesOf({ bindings: { ...bindings, workflow_ids: [], connector_ids: [] } })).toEqual(
      [],
    );
  });

  test("workflows and connectors are bound by id and the fix names the list command", () => {
    const workflows = { bindings: { ...bindings, workflow_ids: ["invoice-reminder"] } };
    expect(issuesOf(workflows)).toEqual([
      "bindings.workflow_ids contains a value that is not an id",
    ]);
    expect(fixOf(workflows)).toBe("use the ids shown by `sk workflows list`");
    expect(fixOf({ bindings: { ...bindings, connector_ids: ["crm"] } })).toBe(
      "use the ids shown by `sk connectors list`",
    );
  });

  test("web_search must be true or false", () => {
    expect(issuesOf({ bindings: { ...bindings, web_search: true } })).toEqual([]);
    expect(issuesOf({ bindings: { ...bindings, web_search: "no" } })).toEqual([
      "bindings.web_search is missing or not true or false",
    ]);
  });
});

describe("task file schedule", () => {
  test("a cron schedule with a timezone and a single run time pass", () => {
    expect(issuesOf({ schedule_cron: "0 7 * * 1-5", schedule_timezone: "Europe/Berlin" })).toEqual(
      [],
    );
    expect(issuesOf({ schedule_cron: "0 7 * * *" })).toEqual([]);
    expect(issuesOf({ schedule_run_at: "2026-12-01T07:00:00+01:00" })).toEqual([]);
    expect(issuesOf({ schedule_run_at: "2026-12-01T06:00:00.000Z" })).toEqual([]);
  });

  test("cron and run time exclude each other", () => {
    expect(
      issuesOf({ schedule_cron: "0 7 * * *", schedule_run_at: "2026-12-01T07:00:00Z" }),
    ).toEqual(["schedule_run_at is set together with schedule_cron"]);
  });

  test("the cron expression needs five fields and a sane length", () => {
    const message = ["schedule_cron is not a cron expression with five fields"];
    expect(issuesOf({ schedule_cron: "every:900" })).toEqual(message);
    expect(issuesOf({ schedule_cron: "0 7 * *" })).toEqual(message);
    expect(issuesOf({ schedule_cron: 7 })).toEqual(message);
    expect(issuesOf({ schedule_cron: `0 7 * * ${"1,".repeat(60)}1` })).toEqual([
      "schedule_cron is longer than 120 characters",
    ]);
  });

  test("the timezone must be known and belongs to a cron schedule", () => {
    expect(issuesOf({ schedule_cron: "0 7 * * *", schedule_timezone: "Mars/Olympus" })).toEqual([
      "schedule_timezone is not a known timezone",
    ]);
    expect(issuesOf({ schedule_cron: "0 7 * * *", schedule_timezone: 1 })).toHaveLength(1);
    expect(issuesOf({ schedule_timezone: "Europe/Berlin" })).toEqual([
      "schedule_timezone is set without schedule_cron",
    ]);
  });

  test("the run time must be a full instant with offset", () => {
    const message = ["schedule_run_at is not a full date and time with offset"];
    expect(issuesOf({ schedule_run_at: "2026-12-01" })).toEqual(message);
    expect(issuesOf({ schedule_run_at: "2026-12-01T07:00:00" })).toEqual(message);
    expect(issuesOf({ schedule_run_at: "2026-13-01T07:00:00Z" })).toEqual(message);
    expect(issuesOf({ schedule_run_at: 1764572400 })).toEqual(message);
  });

  test("several problems are reported together with path and fix", () => {
    const result = parseTaskFile(JSON.stringify(definition({ name: "", environment: "x" })));
    expect(!result.ok && describeTaskFileIssues("task.json", result.issues)).toBe(
      [
        "task.json is not a valid task file:",
        '  name is missing or empty; set "name" to a text of at most 200 characters',
        '  environment must be "dev" or "prod"; set "environment" to "dev" or "prod"',
      ].join("\n"),
    );
  });
});

const task: Task = {
  ...(definition() as unknown as Task),
  id: WORKFLOW,
  description: null,
  category: "finance",
  owner_id: CONNECTOR,
  schedule_cron: "0 7 * * *",
  schedule_timezone: "Europe/Berlin",
  schedule_run_at: null,
  last_claimed_at: null,
  paused_at: null,
  paused_by: null,
  paused_reason: null,
  max_turns: 20,
  run_deadline_minutes: 240,
  fingerprint: "a".repeat(64),
  revision: 3,
  lifecycle: "active",
  created_at: "2026-11-01T08:00:00.000Z",
  updated_at: "2026-11-02T08:00:00.000Z",
};

describe("task update body", () => {
  test("the definition of a task holds exactly the writable fields", () => {
    const writable = taskDefinitionOf(task);
    expect(Object.keys(writable).sort()).toEqual(
      [
        "bindings",
        "category",
        "description",
        "done_when",
        "environment",
        "goal",
        "max_turns",
        "name",
        "plan",
        "run_deadline_minutes",
        "schedule_cron",
        "schedule_run_at",
        "schedule_timezone",
      ].sort(),
    );
    expect(parseTaskFile(JSON.stringify(writable)).ok).toBe(true);
    expect(taskUpdateBody(writable, 3)).toEqual({ ...writable, expected_revision: 3 });
  });
});

describe("schedule flags", () => {
  const current = {
    schedule_cron: "0 7 * * *",
    schedule_timezone: "Europe/Berlin",
    schedule_run_at: null,
  };
  const once = {
    schedule_cron: null,
    schedule_timezone: null,
    schedule_run_at: "2026-12-01T07:00:00Z",
  };

  test("cron and timezone replace the schedule and clear a single run time", () => {
    expect(scheduleFromFlags({ cron: "0 8 * * 1", timezone: "UTC" }, once)).toEqual({
      ok: true,
      schedule: { schedule_cron: "0 8 * * 1", schedule_timezone: "UTC", schedule_run_at: null },
    });
  });

  test("one flag alone keeps the other value of the current schedule", () => {
    expect(scheduleFromFlags({ cron: "0 8 * * 1" }, current)).toEqual({
      ok: true,
      schedule: { ...current, schedule_cron: "0 8 * * 1" },
    });
    expect(scheduleFromFlags({ timezone: "UTC" }, current)).toEqual({
      ok: true,
      schedule: { ...current, schedule_timezone: "UTC" },
    });
  });

  test("a run time replaces the cron schedule and its timezone", () => {
    expect(scheduleFromFlags({ runAt: "2026-12-01T07:00:00+01:00" }, current)).toEqual({
      ok: true,
      schedule: {
        schedule_cron: null,
        schedule_timezone: null,
        schedule_run_at: "2026-12-01T07:00:00+01:00",
      },
    });
  });

  test("no flag at all asks for one", () => {
    const result = scheduleFromFlags({}, current);
    expect(!result.ok && describeFlagIssues(result.issues)).toBe(
      "--file is missing; pass --file <path>, --cron <expr> or --run-at <iso>",
    );
  });

  test("a run time together with cron or timezone is refused", () => {
    for (const flags of [
      { runAt: "2026-12-01T07:00:00Z", cron: "0 8 * * 1" },
      { runAt: "2026-12-01T07:00:00Z", timezone: "UTC" },
    ]) {
      const result = scheduleFromFlags(flags, current);
      expect(!result.ok && result.issues.map((issue) => issue.field)).toEqual(["--run-at"]);
    }
  });

  test("problems are reported by flag name", () => {
    const fields = (
      flags: Parameters<typeof scheduleFromFlags>[0],
      base: Parameters<typeof scheduleFromFlags>[1] = current,
    ) => {
      const result = scheduleFromFlags(flags, base);
      return result.ok ? "" : describeFlagIssues(result.issues);
    };
    expect(fields({ cron: "hourly" })).toBe(
      '--cron is not a cron expression with five fields; use minute hour day month weekday, for example "0 7 * * 1-5"',
    );
    expect(fields({ timezone: "Mars/Olympus" })).toBe(
      '--timezone is not a known timezone; use an IANA name, for example "Europe/Berlin"',
    );
    expect(fields({ timezone: "UTC" }, once)).toBe(
      "--timezone is set without --cron; add --cron or remove the timezone",
    );
    expect(fields({ runAt: "tomorrow" })).toBe(
      '--run-at is not a full date and time with offset; use an ISO instant, for example "2026-12-01T07:00:00+01:00"',
    );
    expect(fields({ cron: "hourly", timezone: "Mars/Olympus" }).split("\n")).toHaveLength(2);
  });
});
