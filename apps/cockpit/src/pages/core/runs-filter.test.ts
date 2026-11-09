import { expect, test } from "bun:test";
import {
  executionsQuery,
  failedStatusesFor,
  filterFromUrl,
  initialRunsFilter,
  runOverlayFromUrl,
  runOverlaySearch,
  runsFilterSearch,
} from "./runs-filter.ts";

const workflow = "ABCDEF01-2345-6789-ABCD-0123456789AB";

test("run filters validate identifiers and normalize timestamps without losing scope", () => {
  const search = new URLSearchParams({
    runs_workflow: ` ${workflow} `,
    runs_status: "succeeded",
    runs_source: "scheduler",
    runs_q: " query ",
    runs_from: " 2026-01-02T12:30:00+02:00 ",
    runs_to: "2026-01-03T12:30Z",
  });
  const filter = filterFromUrl(search.toString());
  expect(filter).toEqual({
    workflowId: workflow,
    status: "succeeded",
    source: "scheduler",
    q: " query ",
    startedFrom: "2026-01-02T10:30:00.000Z",
    startedTo: "2026-01-03T12:30:00.000Z",
  });
  expect(Object.fromEntries(executionsQuery(filter, { limit: 17, offset: 34 }))).toEqual({
    limit: "17",
    offset: "34",
    status: "succeeded",
    request_source: "scheduler",
    workflow_id: workflow,
    q: "query",
    started_from: "2026-01-02T10:30:00.000Z",
    started_to: "2026-01-03T12:30:00.000Z",
  });
  for (const raw of ["bad", `prefix${workflow}`, `${workflow}suffix`, "", workflow.slice(1)]) {
    expect(
      filterFromUrl(new URLSearchParams({ runs_workflow: raw }).toString()).workflowId,
    ).toBeNull();
  }
  for (const raw of [
    "+002026-01-01T00:00Z",
    "2026-01-01T00:00Z\u0000",
    "2026-99-01T12:00Z",
    "2026-01-01",
    "2026-01-01T12:00:00.1234Z",
    "2026-01-01T12:00Z ",
  ]) {
    const expected = raw.endsWith(" ") ? "2026-01-01T12:00:00.000Z" : null;
    expect(filterFromUrl(new URLSearchParams({ runs_from: raw }).toString()).startedFrom).toBe(
      expected,
    );
  }
});

test("blank filters and URL edits preserve unrelated navigation state", () => {
  expect(filterFromUrl(new URLSearchParams({ runs_q: "q".repeat(201) }).toString()).q).toBe(
    "q".repeat(200),
  );
  expect(filterFromUrl("")).toEqual({
    status: "all",
    source: "all",
    q: "",
    workflowId: null,
    startedFrom: null,
    startedTo: null,
  });
  expect(Object.fromEntries(executionsQuery(filterFromUrl(""), { limit: 5, offset: 0 }))).toEqual({
    limit: "5",
    offset: "0",
  });
  expect(
    runsFilterSearch("?keep=1&runs_status=failed&runs_source=cli&runs_q=old", {
      status: "all",
      source: "all",
      q: " ",
    }),
  ).toBe("?keep=1");
  expect(runsFilterSearch("", { status: "all", source: "all", q: "" })).toBe("");
  expect(runsFilterSearch("?keep=1", { status: "failed", source: "cli", q: " needle " })).toBe(
    "?keep=1&runs_status=failed&runs_source=cli&runs_q=needle",
  );
  expect(failedStatusesFor("all")).toBe("failed,timed_out,aborted");
  for (const status of ["failed", "timed_out", "aborted"])
    expect(failedStatusesFor(status)).toBe(status);
  for (const status of ["queued", "running", "succeeded", "unknown"])
    expect(failedStatusesFor(status)).toBeNull();
});

test("run overlays validate bounded identifiers and close only their own URL state", () => {
  expect(runOverlayFromUrl("?runs=all&run=%20a_B.1:2-3%20")).toEqual({
    list: true,
    runId: "a_B.1:2-3",
  });
  expect(runOverlayFromUrl("?runs=other")).toEqual({ list: false, runId: null });
  expect(runOverlayFromUrl(`?run=${"a".repeat(128)}`).runId).toBe("a".repeat(128));
  for (const raw of ["", "a".repeat(129), "a/b", "x!", "!x"]) {
    expect(runOverlayFromUrl(new URLSearchParams({ run: raw }).toString()).runId).toBeNull();
  }
  expect(runOverlaySearch("?keep=1", { list: true, runId: "id" })).toBe("?keep=1&runs=all&run=id");
  expect(
    runOverlaySearch(
      "?runs=all&run=id&runs_status=failed&runs_source=cli&runs_q=x&runs_workflow=x&runs_from=x&runs_to=x&keep=1",
      { list: false, runId: null },
    ),
  ).toBe("?keep=1");
  expect(runOverlaySearch("?runs=all&run=id", { list: false, runId: null })).toBe("");
});

test("initial date range defaults to a week only without an explicit navigation scope", () => {
  const now = Date.parse("2026-01-08T00:00:00Z");
  expect(initialRunsFilter("", now)).toEqual({
    ...filterFromUrl(""),
    startedFrom: "2026-01-01T00:00:00.000Z",
    startedTo: "2026-01-08T00:00:00.000Z",
  });
  for (const search of [
    "?run=",
    "?runs_from=2026-01-01T00:00Z",
    "?runs_to=2026-01-07T00:00Z",
    `?runs_workflow=${workflow}`,
  ]) {
    expect(initialRunsFilter(search, now)).toEqual(filterFromUrl(search));
  }
});
