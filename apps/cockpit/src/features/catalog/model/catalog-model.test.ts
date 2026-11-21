import { describe, expect, test } from "bun:test";
import {
  CATALOG_WORKFLOW_FILTER_STATUSES,
  CATALOG_WORKFLOW_GROUPS,
  type CatalogQueryState,
  catalogGroupFromSearch,
  catalogListParams,
  catalogOperatingStatus,
} from "./catalog-model";

const EXPECTED_WORKFLOW_FILTER_STATUSES = [
  "active",
  "waiting_approval",
  "waiting_connector",
  "failing",
  "stopped",
  "repair_required",
  "unapproved",
  "disabled",
] as const;

const state: CatalogQueryState = {
  q: "",
  status: "all",
  category: "all",
  connector: "",
  sort: "updated_at",
  order: "desc",
};

test("workflow operating filters use the server aggregate before pagination", () => {
  expect(CATALOG_WORKFLOW_FILTER_STATUSES).toEqual(EXPECTED_WORKFLOW_FILTER_STATUSES);
  expect(CATALOG_WORKFLOW_FILTER_STATUSES).toHaveLength(8);
  for (const status of EXPECTED_WORKFLOW_FILTER_STATUSES) {
    const params = catalogListParams({ ...state, status });
    expect(params.operating_status).toBe(status);
    expect(params).not.toHaveProperty("status");
  }
  expect(catalogListParams(state)).not.toHaveProperty("operating_status");
});

test("missing operating evidence never falls back to a lifecycle success state", () => {
  expect(catalogOperatingStatus(undefined)).toBe("unknown");
  expect(catalogOperatingStatus("draft")).toBe("unknown");
  expect(catalogOperatingStatus("archived")).toBe("unknown");
  expect(catalogOperatingStatus("failing")).toBe("failing");
  expect(catalogOperatingStatus("active")).toBe("active");
});

describe("catalog grouping in the address", () => {
  test("a known grouping is read back from the address, so detail → back keeps the tab", () => {
    expect(catalogGroupFromSearch("?group=status&category=sales", CATALOG_WORKFLOW_GROUPS)).toBe(
      "status",
    );
    expect(catalogGroupFromSearch("?group=trigger", CATALOG_WORKFLOW_GROUPS)).toBe("trigger");
  });

  test("an unknown, foreign or missing grouping falls back to category", () => {
    expect(catalogGroupFromSearch("?group=health", CATALOG_WORKFLOW_GROUPS)).toBe("category");
    expect(catalogGroupFromSearch("?group=<x>", CATALOG_WORKFLOW_GROUPS)).toBe("category");
    expect(catalogGroupFromSearch("", CATALOG_WORKFLOW_GROUPS)).toBe("category");
  });

  test("the flat list stays reachable through an explicit all", () => {
    expect(catalogGroupFromSearch("?group=all", CATALOG_WORKFLOW_GROUPS)).toBe("all");
  });

  test("category grouping asks the server for category-first order and keeps the column sort", () => {
    const grouped = catalogListParams({ ...state, group: "category" });
    expect(grouped.group_by).toBe("category");
    expect(grouped.sort).toBe(state.sort);
    expect(catalogListParams({ ...state, group: "status" })).not.toHaveProperty("group_by");
  });
});
