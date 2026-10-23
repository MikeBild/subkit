import { describe, expect, test } from "bun:test";
import {
  CATALOG_GROUPS,
  CATALOG_WORKFLOW_FILTER_STATUSES,
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
  health: null,
  sort: "updated_at",
  order: "desc",
};

test("workflow operating filters use the server aggregate before pagination", () => {
  expect(CATALOG_WORKFLOW_FILTER_STATUSES).toEqual(EXPECTED_WORKFLOW_FILTER_STATUSES);
  expect(CATALOG_WORKFLOW_FILTER_STATUSES).toHaveLength(8);
  for (const status of EXPECTED_WORKFLOW_FILTER_STATUSES) {
    const params = catalogListParams("workflows", { ...state, status });
    expect(params.operating_status).toBe(status);
    expect(params).not.toHaveProperty("status");
    expect(catalogListParams("connectors", { ...state, status })).not.toHaveProperty(
      "operating_status",
    );
  }
  expect(catalogListParams("workflows", state)).not.toHaveProperty("operating_status");
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
    expect(catalogGroupFromSearch("?group=status&category=sales", CATALOG_GROUPS.workflows)).toBe(
      "status",
    );
    expect(catalogGroupFromSearch("?group=trigger", CATALOG_GROUPS.workflows)).toBe("trigger");
    expect(catalogGroupFromSearch("?group=health", CATALOG_GROUPS.connectors)).toBe("health");
  });

  test("an unknown, foreign or missing grouping falls back to all", () => {
    expect(catalogGroupFromSearch("?group=health", CATALOG_GROUPS.workflows)).toBe("all");
    expect(catalogGroupFromSearch("?group=<x>", CATALOG_GROUPS.connectors)).toBe("all");
    expect(catalogGroupFromSearch("", CATALOG_GROUPS.workflows)).toBe("all");
  });
});
