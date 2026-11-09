import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  auditActionsFromUrl,
  auditFilterFromUrl,
  auditLinkParams,
  auditResultFromUrl,
  initialAuditFilter,
} from "./audit-filter";
import {
  executionsQuery,
  failedStatusesFor,
  filterFromUrl,
  initialRunsFilter,
  runOverlayFromUrl,
  runOverlaySearch,
  runsFilterSearch,
} from "./runs-filter";

describe("pure filter contracts", () => {
  test("run filter URL writes round-trip without mutating unrelated parameters", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("all", "failed", "succeeded", "timed_out"),
        fc.constantFrom("all", "api", "cli", "scheduler", "ui"),
        fc.string({ maxLength: 40 }),
        (status, source, q) => {
          const search = runsFilterSearch("?tab=history", { status, source, q });
          const parsed = filterFromUrl(search);
          expect(new URLSearchParams(search).get("tab")).toBe("history");
          expect(parsed).toMatchObject({ status, source, q: q.trim().slice(0, 200) });
        },
      ),
      { seed: 20_261_109, numRuns: 100 },
    );
  });

  test("overlay close removes only its owned run keys", () => {
    const opened = runOverlaySearch("?tab=history&runs_status=failed", {
      list: true,
      runId: "run:1",
    });
    expect(runOverlayFromUrl(opened)).toEqual({ list: true, runId: "run:1" });
    expect(runOverlaySearch(opened, { list: false, runId: null })).toBe("?tab=history");
  });

  test("linked audit filters normalize malformed data and retain valid time bounds", () => {
    const filter = auditFilterFromUrl(
      "?resource_type=workflow&resource_id=abc&action=workflow.created,DROP,workflow.created&ts_from=2026-01-01T00%3A00%3A00Z",
    );
    expect(filter.actions).toEqual(["workflow.created"]);
    expect(filter.tsFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(auditLinkParams(filter)).toEqual({
      resource_type: "workflow",
      resource_id: "abc",
      action: "workflow.created",
      ts_from: "2026-01-01T00:00:00.000Z",
    });
    expect(auditActionsFromUrl("?action=x.y,x.y")).toEqual(["x.y"]);
  });

  test("default windows use caller-injected time and linked records bypass them", () => {
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    expect(initialRunsFilter("", now).startedFrom).toBe("2026-11-02T12:00:00.000Z");
    expect(initialAuditFilter("", now).tsFrom).toBe("2026-10-10T12:00:00.000Z");
    expect(initialAuditFilter("?trace_id=trace-1", now).tsFrom).toBeNull();
  });

  test("query cores preserve each explicit execution and result choice", () => {
    expect(auditResultFromUrl("?result=denied")).toBe("denied");
    expect(auditResultFromUrl("?result=other")).toBeNull();
    expect(
      executionsQuery(
        {
          status: "failed",
          source: "api",
          workflowId: "00000000-0000-4000-8000-000000000001",
          startedFrom: "2026-01-01T00:00:00.000Z",
          startedTo: "2026-01-02T00:00:00.000Z",
          q: "  timeout ",
        },
        { limit: 25, offset: 50 },
      ).toString(),
    ).toContain("q=timeout");
    expect(failedStatusesFor("all")).toBe("failed,timed_out,aborted");
    expect(failedStatusesFor("succeeded")).toBeNull();
  });
});

test("run time filters normalize valid offsets and reject impossible instants", () => {
  const search = new URLSearchParams({
    runs_from: "2026-11-09T11:30+01:00",
    runs_to: "2026-11-09T12:30:45.12Z",
  });
  expect(filterFromUrl(`?${search}`).startedFrom).toBe("2026-11-09T10:30:00.000Z");
  expect(filterFromUrl(`?${search}`).startedTo).toBe("2026-11-09T12:30:45.120Z");
  for (const instant of [
    "2026-99-09T11:30:00Z",
    "2026-11-09T99:30:00Z",
    "2026-11-09",
    "yesterday",
    "",
  ]) {
    const invalid = filterFromUrl(
      `?${new URLSearchParams({ runs_from: instant, runs_to: instant })}`,
    );
    expect(invalid.startedFrom).toBeNull();
    expect(invalid.startedTo).toBeNull();
  }
});
