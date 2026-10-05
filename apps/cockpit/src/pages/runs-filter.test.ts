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
    const filter = filterFromUrl("?status=failed&source=scheduler");
    expect(filter.status).toBe("failed");
    expect(filter.source).toBe("scheduler");
  });

  test("a source the page cannot name narrows nothing", () => {
    expect(filterFromUrl("?source=carrier-pigeon").source).toBe("all");
    expect(filterFromUrl("?source=").source).toBe("all");
    expect(filterFromUrl("").source).toBe("all");
  });

  test("every source the page offers is one it accepts from a link", () => {
    for (const source of REQUEST_SOURCES) {
      expect(isKnownRequestSource(source)).toBe(true);
      expect(filterFromUrl(`?source=${source}`).source).toBe(source);
    }
  });

  test("`ui` is a source the page can name", () => {
    expect(isKnownRequestSource("ui")).toBe(true);
  });

  test("an unknown status still falls back to all, as it did before", () => {
    expect(filterFromUrl("?status=bogus").status).toBe("all");
    expect(filterFromUrl("?status=failed").status).toBe("failed");
  });

  test("the search needle is bounded", () => {
    expect(filterFromUrl(`?q=${"x".repeat(500)}`).q).toHaveLength(200);
  });

  test("a workflow id narrows the query the engine receives", () => {
    const id = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
    const filter = filterFromUrl(`?workflow_id=${id}&status=failed`);
    expect(filter.workflowId).toBe(id);
    const params = executionsQuery(filter, { limit: 25, offset: 0 });
    expect(params.get("workflow_id")).toBe(id);
    expect(params.get("status")).toBe("failed");
    expect(params.has("request_source")).toBe(false);
  });

  test("a workflow id the engine would refuse narrows nothing", () => {
    for (const bad of ["", "abc", "monthly report", "018f4b4a-6d33-7b3a-9c2d"])
      expect(filterFromUrl(`?workflow_id=${encodeURIComponent(bad)}`).workflowId).toBeNull();
    expect(
      executionsQuery(filterFromUrl("?workflow_id=abc"), { limit: 25, offset: 0 }).has(
        "workflow_id",
      ),
    ).toBe(false);
  });
});

describe("the filter the address keeps", () => {
  test("status, source and search are written, the rest of the address stays", () => {
    expect(
      runsFilterSearch("?runs=all&workflow_id=abc", {
        status: "failed",
        source: "scheduler",
        q: " Bericht ",
      }),
    ).toBe("?runs=all&workflow_id=abc&status=failed&source=scheduler&q=Bericht");
  });

  test("a filter set back to all leaves the address", () => {
    expect(
      runsFilterSearch("?runs=all&status=failed&source=api&q=x", {
        status: "all",
        source: "all",
        q: "",
      }),
    ).toBe("?runs=all");
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
