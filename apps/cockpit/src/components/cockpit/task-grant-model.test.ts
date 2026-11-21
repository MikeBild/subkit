import { describe, expect, test } from "bun:test";
import {
  AUTHORITY_REPORT,
  BOOKS,
  CONNECTOR_NAMES,
  DIGEST_MATCH,
  FINGERPRINT,
  liveGrant,
  manifest,
  preview,
  QUOTE,
  REPORT,
  WF_MATCH,
  WF_QUOTE,
  WF_REPORT,
  workflow,
} from "@/components/cockpit/task-grant-fixtures";
import {
  blockedNotice,
  blockedRows,
  blockReasonOf,
  effectSummary,
  grantOutcome,
  grantValidity,
  type TaskGrantResult,
  taskGrantInput,
  taskGrantRows,
  taskScheduleLine,
  type WorkflowRow,
  workflowStanding,
} from "@/components/cockpit/task-grant-model";
import { LOCALE_TAGS, type Locale, translate } from "@/lib/i18n";

const NOW = Date.parse("2026-11-19T10:00:00.000Z");
const rows = (input = preview()) => taskGrantRows(input, CONNECTOR_NAMES, "Unbekannt");
const workflowRows = (input = preview()) =>
  rows(input).filter((row): row is WorkflowRow => row.kind === "workflow");
const line = (schedule: Parameters<typeof taskScheduleLine>[0], locale: Locale = "de") =>
  taskScheduleLine(
    schedule,
    (key, values) => translate(locale, key, values),
    LOCALE_TAGS[locale],
    (value) => `<${value}>`,
  );
const noSchedule = { schedule_cron: null, schedule_timezone: null, schedule_run_at: null };

describe("the rows of what a task may use", () => {
  test("come grouped as reads, then writes, then starts", () => {
    expect(rows().map((row) => row.verb)).toEqual(["read", "write", "start", "start", "start"]);
  });

  test("a connector reads or writes by the owner's access and is only used when that is unknown", () => {
    const listed = rows(
      preview({
        workflows: [],
        connectors: [
          { connector_id: BOOKS, name: "Buchhaltung", access: "read-only" },
          { connector_id: BOOKS, name: "Postfach", access: "read-write" },
          { connector_id: BOOKS, name: "Lager", access: null },
          { connector_id: BOOKS, name: null, access: "none" },
        ],
      }),
    );
    expect(listed.map((row) => [row.verb, row.kind === "connector" ? row.name : null])).toEqual([
      ["read", "Buchhaltung"],
      ["write", "Postfach"],
      ["use", "Lager"],
      ["use", null],
    ]);
    expect(listed.at(-1)).toMatchObject({ connectorId: null });
  });

  test("web search is a row that reads", () => {
    expect(rows(preview({ workflows: [], connectors: [], web_search: true }))).toEqual([
      { kind: "web", key: "web", verb: "read" },
    ]);
  });

  test("a workflow says in plain words what it reaches, reads before writes", () => {
    const [match] = workflowRows();
    expect(match?.summary).toEqual([
      { word: "read", name: "Bank" },
      { word: "write", name: "Buchhaltung" },
    ]);
  });

  test("the strongest effect per service wins and an unnamed service falls back to its host", () => {
    const mixed = manifest(WF_MATCH, [
      ...(workflow().effect_manifest?.effects ?? []),
      {
        ...(workflow().effect_manifest?.effects[0] as object),
        connector_id: BOOKS,
        effect: "destructive",
      },
      {
        ...(workflow().effect_manifest?.effects[0] as object),
        connector_id: null,
        effect: "unknown",
      },
      { ...(workflow().effect_manifest?.effects[0] as object), connector_id: null, target: null },
    ] as never);
    expect(effectSummary(mixed, CONNECTOR_NAMES, "Unbekannt")).toEqual([
      { word: "read", name: "Bank" },
      { word: "read", name: "Unbekannt" },
      { word: "unknown", name: "api.example.test" },
      { word: "delete", name: "Buchhaltung" },
    ]);
    expect(effectSummary(null, CONNECTOR_NAMES, "Unbekannt")).toEqual([]);
  });
});

describe("where a bound workflow stands", () => {
  test("an approvable workflow is part of what is allowed", () => {
    expect(workflowStanding(workflow(), new Set())).toBe("included");
    expect(blockReasonOf(workflow())).toBeNull();
  });

  test("an existing approval is its own unless the standing permission created it", () => {
    expect(workflowStanding(REPORT, new Set())).toBe("covered");
    expect(workflowStanding(REPORT, new Set([AUTHORITY_REPORT]))).toBe("co_granted");
  });

  test("a workflow that cannot repeat, or that the person may not approve, asks every time", () => {
    expect(workflowStanding(QUOTE, new Set())).toBe("asks");
    const foreign = workflow({ may_grant: false });
    expect(blockReasonOf(foreign)).toBe("workflow_permission_missing");
    expect(workflowStanding(foreign, new Set())).toBe("asks");
  });

  test("a covered workflow is not blocked by a missing right to approve", () => {
    expect(blockReasonOf({ ...REPORT, may_grant: false })).toBeNull();
  });

  test.each([
    "workflow_missing",
    "workflow_not_active",
    "workflow_sensitive",
    "workflow_not_readable",
  ] as const)("%s makes the workflow unavailable", (blocked_reason) => {
    expect(workflowStanding(workflow({ blocked_reason }), new Set())).toBe("unavailable");
  });
});

describe("the one notice about workflows that cannot be allowed", () => {
  const asks = { name: "Angebot erstellen", standing: "asks" } as const;
  const gone = { name: null, standing: "unavailable" } as const;

  test("is absent when every workflow can be allowed", () => {
    expect(
      blockedNotice(blockedRows(rows(preview({ workflows: [workflow(), REPORT] })))),
    ).toBeNull();
  });

  test("names a single workflow and says that it asks on every run", () => {
    expect(blockedNotice(blockedRows(rows()))).toEqual({
      key: "taskGrant.blocked.asks.one",
      name: "Angebot erstellen",
    });
  });

  test("names a single unavailable workflow without claiming that it asks", () => {
    expect(blockedNotice([gone])).toEqual({ key: "taskGrant.blocked.unavailable.one", name: null });
  });

  test("counts several and only claims what holds for all of them", () => {
    expect(blockedNotice([asks, asks])).toEqual({ key: "taskGrant.blocked.asks.other", count: 2 });
    expect(blockedNotice([gone, gone])).toEqual({
      key: "taskGrant.blocked.unavailable.other",
      count: 2,
    });
    expect(blockedNotice([asks, gone, asks])).toEqual({ key: "taskGrant.blocked.mixed", count: 3 });
  });
});

describe("the sentence with the schedule", () => {
  test("puts a known rhythm into words in both languages", () => {
    expect(line({ ...noSchedule, schedule_cron: "0 7 * * *" })).toBe(
      "Sie startet täglich um 07:00 und darf dabei:",
    );
    expect(line({ ...noSchedule, schedule_cron: "0 7 * * *" }, "en")).toBe(
      "It starts daily at 07:00 and may:",
    );
  });

  test("never shows a rhythm it cannot put into words", () => {
    const own = line({ ...noSchedule, schedule_cron: "5 4 1-7 3 2" });
    expect(own).toBe("Sie startet nach eigenem Rhythmus und darf dabei:");
    expect(own).not.toContain("1-7");
  });

  test("names the date of a single start and says when a task only starts by hand", () => {
    expect(line({ ...noSchedule, schedule_run_at: "2026-11-20T07:00:00.000Z" })).toBe(
      "Sie startet einmal am <2026-11-20T07:00:00.000Z> und darf dabei:",
    );
    expect(line(noSchedule)).toBe("Du startest sie von Hand, und sie darf dabei:");
    expect(line(noSchedule, "en")).toBe("You start it by hand, and it may:");
  });
});

describe("what the allow request carries", () => {
  test("the reviewed fingerprint, no run limit and the digest of every workflow that is allowed with it", () => {
    expect(taskGrantInput(preview(), { validUntil: null, maxRuns: null })).toEqual({
      expected_fingerprint: FINGERPRINT,
      valid_until: null,
      max_runs: null,
      expected_workflow_digests: { [WF_MATCH]: DIGEST_MATCH },
    });
  });

  test("the chosen end and run limit are sent as they are", () => {
    expect(
      taskGrantInput(preview(), { validUntil: "2026-11-26T22:59:59.000Z", maxRuns: 5 }),
    ).toMatchObject({ valid_until: "2026-11-26T22:59:59.000Z", max_runs: 5 });
  });

  test("a workflow the person was told would ask is never sent as reviewed", () => {
    const digests = taskGrantInput(
      preview({ workflows: [QUOTE, REPORT, workflow({ may_grant: false })] }),
      { validUntil: null, maxRuns: null },
    ).expected_workflow_digests;
    expect(digests).toEqual({});
  });
});

describe("the validity of a standing permission", () => {
  test("none without a permission or after a revoke", () => {
    expect(grantValidity(null, NOW)).toEqual({ state: "none" });
    expect(grantValidity(liveGrant({ revoked_at: "2026-11-02T00:00:00.000Z" }), NOW)).toEqual({
      state: "none",
    });
  });

  test("live until revoked, or until its end with the runs that are left", () => {
    expect(grantValidity(liveGrant(), NOW)).toEqual({
      state: "live",
      until: null,
      remainingRuns: null,
    });
    expect(
      grantValidity(
        liveGrant({ valid_until: "2026-12-01T00:00:00.000Z", max_runs: 10, reserved_runs: 4 }),
        NOW,
      ),
    ).toEqual({ state: "live", until: "2026-12-01T00:00:00.000Z", remainingRuns: 6 });
  });

  test("expired once its end has passed and used up without runs left", () => {
    expect(grantValidity(liveGrant({ valid_until: "2026-11-19T10:00:00.000Z" }), NOW)).toEqual({
      state: "expired",
      until: "2026-11-19T10:00:00.000Z",
    });
    expect(grantValidity(liveGrant({ max_runs: 3, reserved_runs: 3 }), NOW)).toEqual({
      state: "exhausted",
    });
  });
});

describe("the result of allowing", () => {
  const result = (workflows: TaskGrantResult["workflows"]): TaskGrantResult => ({
    grant: liveGrant(),
    changed: true,
    superseded_grant_ids: [],
    workflows,
  });

  test("says for every bound workflow whether it was allowed with it", () => {
    const settled = grantOutcome(
      result([
        { workflow_id: WF_MATCH, outcome: "granted", authority_id: AUTHORITY_REPORT, reason: null },
        {
          workflow_id: WF_QUOTE,
          outcome: "not_granted",
          authority_id: null,
          reason: "workflow_not_repeatable",
        },
        {
          workflow_id: WF_REPORT,
          outcome: "covered",
          authority_id: AUTHORITY_REPORT,
          reason: null,
        },
      ]),
      preview(),
    );
    expect(settled.rows.map((row) => [row.name, row.standing])).toEqual([
      ["Zahlungsabgleich", "co_granted"],
      ["Angebot erstellen", "asks"],
      ["Wochenbericht", "covered"],
    ]);
    expect(settled.refused.map((row) => row.workflowId)).toEqual([WF_QUOTE]);
    expect(settled.unexpected).toBe(0);
  });

  test("a workflow that was refused only on allowing is news the person has not read yet", () => {
    const settled = grantOutcome(
      result([
        {
          workflow_id: WF_MATCH,
          outcome: "not_granted",
          authority_id: null,
          reason: "workflow_not_repeatable",
        },
        {
          workflow_id: "30000000-0000-4000-8000-000000000009",
          outcome: "not_granted",
          authority_id: null,
          reason: "workflow_missing",
        },
        { workflow_id: WF_REPORT, outcome: "not_granted", authority_id: null, reason: null },
      ]),
      preview(),
    );
    expect(settled.unexpected).toBe(3);
    expect(settled.rows.map((row) => [row.name, row.standing, row.reason])).toEqual([
      ["Zahlungsabgleich", "asks", "workflow_not_repeatable"],
      [null, "unavailable", "workflow_missing"],
      ["Wochenbericht", "asks", null],
    ]);
  });
});
