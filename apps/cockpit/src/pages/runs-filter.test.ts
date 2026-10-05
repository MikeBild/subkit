import { describe, expect, test } from "bun:test";
import {
  executionsQuery,
  failedStatusesFor,
  filterFromUrl,
  isKnownRequestSource,
  REQUEST_SOURCES,
  runsFilterSearch,
} from "@/pages/runs-model";

describe("the filter a link asks for", () => {
  test("reads BOTH halves of the incidents link", () => {
    const filter = filterFromUrl("?runs_status=failed&runs_source=scheduler");
    expect(filter.status).toBe("failed");
    expect(filter.source).toBe("scheduler");
  });

  test("a source the page cannot name narrows nothing", () => {
    expect(filterFromUrl("?runs_source=carrier-pigeon").source).toBe("all");
    expect(filterFromUrl("?runs_source=").source).toBe("all");
    expect(filterFromUrl("").source).toBe("all");
  });

  test("every source the page offers is one it accepts from a link", () => {
    for (const source of REQUEST_SOURCES) {
      expect(isKnownRequestSource(source)).toBe(true);
      expect(filterFromUrl(`?runs_source=${source}`).source).toBe(source);
    }
  });

  test("`ui` is a source the page can name", () => {
    expect(isKnownRequestSource("ui")).toBe(true);
  });

  test("an unknown status still falls back to all, as it did before", () => {
    expect(filterFromUrl("?runs_status=bogus").status).toBe("all");
    expect(filterFromUrl("?runs_status=failed").status).toBe("failed");
  });

  test("the search needle is bounded", () => {
    expect(filterFromUrl(`?runs_q=${"x".repeat(500)}`).q).toHaveLength(200);
  });

  test("a workflow id narrows the query the engine receives", () => {
    const id = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
    const filter = filterFromUrl(`?runs_workflow=${id}&runs_status=failed`);
    expect(filter.workflowId).toBe(id);
    const params = executionsQuery(filter, { limit: 25, offset: 0 });
    expect(params.get("workflow_id")).toBe(id);
    expect(params.get("status")).toBe("failed");
    expect(params.has("request_source")).toBe(false);
  });

  test("a workflow id the engine would refuse narrows nothing", () => {
    for (const bad of ["", "abc", "monthly report", "018f4b4a-6d33-7b3a-9c2d"])
      expect(filterFromUrl(`?runs_workflow=${encodeURIComponent(bad)}`).workflowId).toBeNull();
    expect(
      executionsQuery(filterFromUrl("?runs_workflow=abc"), { limit: 25, offset: 0 }).has(
        "workflow_id",
      ),
    ).toBe(false);
  });
});

describe("the filter the address keeps", () => {
  test("status, source and search are written, the rest of the address stays", () => {
    expect(
      runsFilterSearch("?runs=all&runs_workflow=abc", {
        status: "failed",
        source: "scheduler",
        q: " Bericht ",
      }),
    ).toBe("?runs=all&runs_workflow=abc&runs_status=failed&runs_source=scheduler&runs_q=Bericht");
  });

  test("a filter set back to all leaves the address", () => {
    expect(
      runsFilterSearch("?runs=all&runs_status=failed&runs_source=api&runs_q=x", {
        status: "all",
        source: "all",
        q: "",
      }),
    ).toBe("?runs=all");
  });

  test("filtering over a page leaves the page's own q, status and source alone", () => {
    const host = "?q=foo&status=active&source=import&runs=all";
    const filtered = runsFilterSearch(host, { status: "failed", source: "api", q: "Bericht" });
    const params = new URLSearchParams(filtered);
    expect([params.get("q"), params.get("status"), params.get("source")]).toEqual([
      "foo",
      "active",
      "import",
    ]);
    expect([params.get("runs_q"), params.get("runs_status"), params.get("runs_source")]).toEqual([
      "Bericht",
      "failed",
      "api",
    ]);
    expect(runsFilterSearch(filtered, { status: "all", source: "all", q: "" })).toBe(host);
  });

  test("the page's own q and status are not read as the list's filter", () => {
    const read = filterFromUrl("?q=foo&status=failed&source=api&runs=all");
    expect([read.status, read.source, read.q]).toEqual(["all", "all", ""]);
  });

  test("what the address keeps is what the page reads back", () => {
    const search = runsFilterSearch("?runs=all", { status: "timed_out", source: "chat", q: "a" });
    const read = filterFromUrl(search);
    expect([read.status, read.source, read.q]).toEqual(["timed_out", "chat", "a"]);
  });
});

describe("the failed count asks the engine", () => {
  test("without a status filter it counts every failing status", () => {
    expect(failedStatusesFor("all")).toBe("failed,timed_out,aborted");
  });

  test("a failing status counts itself, any other status counts none", () => {
    expect(failedStatusesFor("timed_out")).toBe("timed_out");
    expect(failedStatusesFor("succeeded")).toBeNull();
    expect(failedStatusesFor("running")).toBeNull();
  });
});
