import { describe, expect, test } from "bun:test";
import type { FailureGroup } from "./overview-model";
import {
  distinctStatus,
  metricOffersDrilldown,
  partitionFailures,
  recentRuns,
} from "./overview-model";

const group = (
  origin: FailureGroup["origin"],
  count: number,
  signature: string,
  // How many of the runs the scheduler started. `origin` cannot say: it
  // collapses to "mixed" whether the other runs were manual retries of a
  // failing schedule or a second kind of trial that never ran unattended.
  scheduled_count = origin === "scheduled" ? count : 0,
  resolved_at: string | null = null,
): FailureGroup =>
  ({
    signature,
    workflow_id: "w",
    workflow_name: "Report",
    step_key: "s",
    error_code: "boom",
    origin,
    count,
    scheduled_count,
    last_seen: "2026-08-18T10:00:00.000Z",
    resolved_at,
    cause: "it broke",
    guidance: "",
  }) as FailureGroup;

describe("partitionFailures", () => {
  test("keeps trial runs out of the incident picture", () => {
    // Someone building a workflow can fail two dozen trial runs in an
    // afternoon. Counting those as incidents reports a crisis that is not
    // happening.
    const { incidents, trials } = partitionFailures([
      group("authoring", 30, "a"),
      group("scheduled", 4, "b"),
      group("manual", 7, "c"),
      // Mixed because a scheduled run was retried by hand: still an incident.
      group("mixed", 2, "d", 1),
    ]);
    expect(incidents.map((entry) => entry.signature)).toEqual(["b", "d"]);
    expect(trials.map((entry) => entry.signature)).toEqual(["a", "c"]);
  });

  test("mixed is not a verdict — what counts is whether the clock started it", () => {
    // The same word for two different situations. Tried by hand and tried in
    // the editor is still nobody's incident; a schedule someone retried is.
    const { incidents, trials } = partitionFailures([
      group("mixed", 5, "hand-and-editor", 0),
      group("mixed", 5, "schedule-then-retry", 4),
    ]);
    expect(incidents.map((entry) => entry.signature)).toEqual(["schedule-then-retry"]);
    expect(trials.map((entry) => entry.signature)).toEqual(["hand-and-editor"]);
  });

  test("a recovered incident is history, and is filed as neither of the other two", () => {
    // Not `trials`: a production outage that ended is not something somebody
    // was trying out, and putting it there would label it as one. Not
    // `incidents` either — there is nothing left to decide.
    const { incidents, trials, recovered } = partitionFailures([
      group("scheduled", 4, "healed", 4, "2026-08-19T04:12:00.000Z"),
      group("scheduled", 4, "still-broken", 4),
      group("authoring", 3, "trial"),
    ]);
    expect(incidents.map((entry) => entry.signature)).toEqual(["still-broken"]);
    expect(trials.map((entry) => entry.signature)).toEqual(["trial"]);
    expect(recovered.map((entry) => entry.signature)).toEqual(["healed"]);
  });

  test("sorts the loudest failure first within each pile", () => {
    const { incidents } = partitionFailures([
      group("scheduled", 2, "small"),
      group("mixed", 9, "big", 9),
    ]);
    expect(incidents.map((entry) => entry.signature)).toEqual(["big", "small"]);
  });
});

describe("recentRuns", () => {
  const run = (id: string, created: string, started?: string, finished?: string) =>
    ({
      id,
      workflow_id: "w",
      workflow_name: "Report",
      status: "succeeded",
      created_at: created,
      started_at: started ?? null,
      finished_at: finished ?? null,
    }) as never;

  test("newest first, capped", () => {
    const runs = recentRuns(
      [
        run("a", "2026-08-18T09:00:00.000Z"),
        run("b", "2026-08-18T11:00:00.000Z"),
        run("c", "2026-08-18T10:00:00.000Z"),
      ],
      2,
    );
    expect(runs.map((entry) => entry.id)).toEqual(["b", "c"]);
  });

  test("an unfinished run has no duration rather than a zero one", () => {
    const [only] = recentRuns([run("a", "2026-08-18T09:00:00.000Z", "2026-08-18T09:00:00.000Z")]);
    expect(only?.durationMs).toBeNull();
  });

  test("a finished run measures wall clock", () => {
    const [only] = recentRuns([
      run("a", "2026-08-18T09:00:00.000Z", "2026-08-18T09:00:00.000Z", "2026-08-18T09:00:12.000Z"),
    ]);
    expect(only?.durationMs).toBe(12_000);
  });
});

describe("the way in from a number", () => {
  test("a metric that counted something offers the way in", () => {
    expect(metricOffersDrilldown("executions.incidents_24h", 3)).toBe(true);
  });

  test("a metric standing at zero offers none", () => {
    // The live defect: "production incidents: 0" with a link to 977 rows.
    expect(metricOffersDrilldown("executions.incidents_24h", 0)).toBe(false);
  });

  test("an unreadable value is unknown, not empty, and still offers none", () => {
    expect(metricOffersDrilldown("executions.incidents_24h", null)).toBe(false);
    expect(metricOffersDrilldown("executions.incidents_24h", undefined)).toBe(false);
  });

  test("the metrics whose link led nowhere useful stay linkless at any value", () => {
    // Each of these once carried a link to a list that could not tell its own
    // number apart. A non-zero value must not bring the link back.
    for (const id of [
      "automation.active_workflows",
      "executions.total_24h",
      "executions.success_ratio",
      "executions.trial_failures_24h",
      "connectors.healthy_ratio",
      "repairs.applied_ratio",
      "skills.reusable",
    ]) {
      expect(metricOffersDrilldown(id, 42)).toBe(false);
    }
  });

  test("trial failures and production incidents are not the same decision", () => {
    // They opened the identical URL. Whatever else changes, these two must not
    // collapse back into one another.
    expect(metricOffersDrilldown("executions.incidents_24h", 1)).toBe(true);
    expect(metricOffersDrilldown("executions.trial_failures_24h", 1)).toBe(false);
  });
});

describe("distinctStatus", () => {
  test("a status line that repeats the value is dropped", () => {
    // "Betriebszustand: Gesund / Gesund" and "Datenstand: Aktuell / Aktuell".
    expect(distinctStatus("Gesund", "Gesund")).toBeUndefined();
    expect(distinctStatus("Aktuell", " Aktuell ")).toBeUndefined();
  });

  test("a status line that adds a fact stays", () => {
    expect(distinctStatus("3 h", "Veraltet")).toBe("Veraltet");
  });

  test("no status is no status", () => {
    expect(distinctStatus("12", undefined)).toBeUndefined();
  });
});
