import { describe, expect, test } from "bun:test";
import {
  classifyRun,
  cronDueWindow,
  everyDueWindow,
  onceDueWindow,
  planOccurrenceWrite,
} from "./occurrence-window.ts";

const at = (iso: string) => new Date(iso);

describe("cronDueWindow", () => {
  test("nothing is due before the next occurrence", () => {
    expect(
      cronDueWindow("0 9 * * *", "UTC", at("2026-11-20T09:00:00Z"), at("2026-11-20T18:00:00Z")),
    ).toBeNull();
  });

  test("one due occurrence", () => {
    expect(
      cronDueWindow("0 9 * * *", "UTC", at("2026-11-19T09:00:00Z"), at("2026-11-20T09:00:30Z")),
    ).toEqual({
      first_due: at("2026-11-20T09:00:00Z"),
      last_due: at("2026-11-20T09:00:00Z"),
      count: 1,
    });
  });

  test("counts every occurrence that came due since the anchor", () => {
    expect(
      cronDueWindow("0 * * * *", "UTC", at("2026-11-20T00:30:00Z"), at("2026-11-20T04:10:00Z")),
    ).toEqual({
      first_due: at("2026-11-20T01:00:00Z"),
      last_due: at("2026-11-20T04:00:00Z"),
      count: 4,
    });
  });

  test("honours the schedule timezone", () => {
    const window = cronDueWindow(
      "0 9 * * *",
      "Europe/Berlin",
      at("2026-11-19T12:00:00Z"),
      at("2026-11-20T08:30:00Z"),
    );
    expect(window?.first_due).toEqual(at("2026-11-20T08:00:00Z"));
  });

  test("caps the count and still names the newest due occurrence", () => {
    const window = cronDueWindow(
      "* * * * *",
      "UTC",
      at("2026-11-01T00:00:00Z"),
      at("2026-11-20T00:00:30Z"),
      10,
    );
    expect(window?.count).toBe(10);
    expect(window?.first_due).toEqual(at("2026-11-01T00:01:00Z"));
    expect(window?.last_due).toEqual(at("2026-11-20T00:00:00Z"));
  });

  test("an invalid or interval expression has no window", () => {
    expect(
      cronDueWindow("every:30", "UTC", at("2026-11-01T00:00:00Z"), at("2026-11-02T00:00:00Z")),
    ).toBeNull();
    expect(
      cronDueWindow("not cron", "UTC", at("2026-11-01T00:00:00Z"), at("2026-11-02T00:00:00Z")),
    ).toBeNull();
  });
});

describe("everyDueWindow", () => {
  test("counts whole intervals since the anchor", () => {
    expect(everyDueWindow(60, at("2026-11-20T10:00:00Z"), at("2026-11-20T10:03:30Z"))).toEqual({
      first_due: at("2026-11-20T10:01:00Z"),
      last_due: at("2026-11-20T10:03:00Z"),
      count: 3,
    });
    expect(everyDueWindow(60, at("2026-11-20T10:00:00Z"), at("2026-11-20T10:00:59Z"))).toBeNull();
    expect(everyDueWindow(0, at("2026-11-20T10:00:00Z"), at("2026-11-20T11:00:00Z"))).toBeNull();
  });
});

describe("onceDueWindow", () => {
  test("is due once and never again after it was recorded", () => {
    const run_at = at("2026-11-20T10:00:00Z");
    expect(onceDueWindow(run_at, null, at("2026-11-20T09:59:00Z"))).toBeNull();
    expect(onceDueWindow(run_at, null, at("2026-11-20T10:00:00Z"))?.count).toBe(1);
    expect(onceDueWindow(run_at, run_at, at("2026-11-20T11:00:00Z"))).toBeNull();
  });
});

describe("classifyRun", () => {
  const due = at("2026-11-20T09:00:00Z");
  const single = { first_due: due, last_due: due, count: 1 };

  test("a run close to its due time ran", () => {
    expect(classifyRun(single, at("2026-11-20T09:00:40Z"))).toEqual({
      state: "ran",
      reason_code: null,
      skipped_count: 0,
    });
    expect(classifyRun(single, at("2026-11-20T09:05:00Z")).state).toBe("ran");
  });

  test("a run more than five minutes after its due time ran late", () => {
    expect(classifyRun(single, at("2026-11-20T09:05:01Z"))).toEqual({
      state: "ran_late",
      reason_code: "late_start",
      skipped_count: 0,
    });
  });

  test("a run that stands for several due occurrences names how many it merged", () => {
    expect(
      classifyRun(
        { first_due: at("2026-11-20T06:00:00Z"), last_due: due, count: 4 },
        at("2026-11-20T09:00:10Z"),
      ),
    ).toEqual({ state: "ran_late", reason_code: "merged_missed", skipped_count: 3 });
  });
});

describe("planOccurrenceWrite", () => {
  const prior = {
    state: "held" as const,
    reason_code: "execution_authority_expired",
    last_due_at: at("2026-11-20T09:00:00Z"),
  };

  test("a run always gets its own row", () => {
    expect(planOccurrenceWrite(prior, { state: "ran", reason_code: null })).toEqual({
      kind: "insert",
    });
  });

  test("the same hold or skip continues the newest row", () => {
    expect(
      planOccurrenceWrite(prior, {
        state: "held",
        reason_code: "execution_authority_expired",
      }),
    ).toEqual({ kind: "merge", after: prior.last_due_at });
  });

  test("another reason or state starts a new row", () => {
    expect(planOccurrenceWrite(prior, { state: "held", reason_code: "input_required" })).toEqual({
      kind: "insert",
    });
    expect(
      planOccurrenceWrite(prior, { state: "skipped", reason_code: "failure_backoff" }),
    ).toEqual({ kind: "insert" });
    expect(planOccurrenceWrite(null, { state: "skipped", reason_code: "calendar_gate" })).toEqual({
      kind: "insert",
    });
  });
});
