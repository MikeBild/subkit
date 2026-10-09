import { expect, test } from "bun:test";
import { WORKFLOW_OPERATING_STATUSES } from "@shared/workflow-operating-status.ts";
import { type CatalogQueryState, catalogListParams, catalogOperatingStatus } from "./catalog-model";

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
  for (const status of WORKFLOW_OPERATING_STATUSES) {
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
