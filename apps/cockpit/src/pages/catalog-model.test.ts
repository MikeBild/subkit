import { expect, test } from "bun:test";
import {
  CATALOG_WORKFLOW_FILTER_STATUSES,
  type CatalogQueryState,
  catalogListParams,
  catalogOperatingStatus,
  catalogSelectedId,
  catalogSelectionHref,
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

test("catalogue selection preserves filters and remains a shareable list URL", () => {
  const selected = catalogSelectionHref("/cockpit/workflows", "?q=archive&status=active", "wf-1");
  expect(selected).toBe("/cockpit/workflows?q=archive&status=active&selected=wf-1");
  expect(catalogSelectedId(new URL(selected, "https://example.test").search)).toBe("wf-1");
  expect(catalogSelectionHref("/cockpit/workflows", "?q=archive&selected=wf-1", null)).toBe(
    "/cockpit/workflows?q=archive",
  );
  expect(catalogSelectedId(`?selected=${"x".repeat(201)}`)).toBeNull();
});
