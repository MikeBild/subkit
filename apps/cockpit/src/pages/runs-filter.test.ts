import { describe, expect, test } from "bun:test";
import {
  executionsQuery,
  filterFromUrl,
  isKnownRequestSource,
  REQUEST_SOURCES,
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
