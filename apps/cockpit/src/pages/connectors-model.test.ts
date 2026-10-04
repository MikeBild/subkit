import { describe, expect, test } from "bun:test";
import { connectorsHref } from "@/app/links";
import { stringValue } from "@/components/cockpit/table-columns";
import { catalogListParams } from "@/pages/catalog-model";
import { connectorHealthFilterFromUrl, workflowsByConnector } from "@/pages/connectors-model";

const workflows = [
  { id: "w1", name: "Monthly report", connectors: ["reporting-api", "mailer"] },
  { id: "w2", name: "Daily digest", connectors: ["mailer"] },
];

describe("connector usage", () => {
  test("a workflow with two connectors appears under both", () => {
    const byConnector = workflowsByConnector(workflows);
    expect(byConnector.get("reporting-api")?.map((workflow) => workflow.name)).toEqual([
      "Monthly report",
    ]);
    expect(byConnector.get("mailer")?.map((workflow) => workflow.name)).toEqual([
      "Monthly report",
      "Daily digest",
    ]);
  });

  test("an unused connector has no entry, and its cell reads as a missing value", () => {
    const byConnector = workflowsByConnector(workflows);
    const used = byConnector.get("archived-service") ?? [];
    expect(used).toEqual([]);
    expect(stringValue(used)).toBe("—");
  });

  test("no workflows at all leaves the index empty", () => {
    expect(workflowsByConnector([]).size).toBe(0);
  });
});

describe("connectors that count against health", () => {
  const state = {
    q: "",
    status: "all",
    category: "all",
    connector: "",
    health: "not_ok" as const,
    sort: "name",
    order: "asc" as const,
    page: 2,
  };

  test("the narrowing is the engine's, and the page is a page of the narrowed list", () => {
    const params = catalogListParams("connectors", state, 25);
    expect(params.get("health")).toBe("not_ok");
    expect(params.get("limit")).toBe("25");
    expect(params.get("offset")).toBe("50");
    expect(params.has("enabled")).toBe(false);
  });

  test("only the connector list carries it", () => {
    expect(catalogListParams("workflows", state, 25).has("health")).toBe(false);
    expect(catalogListParams("connectors", { ...state, health: null }, 25).has("health")).toBe(
      false,
    );
  });

  test("the address carries one narrowing, and nothing else is read as it", () => {
    expect(connectorHealthFilterFromUrl("?health=not_ok")).toBe("not_ok");
    expect(connectorHealthFilterFromUrl(query(connectorsHref({ health: "not_ok" })))).toBe(
      "not_ok",
    );
    expect(connectorHealthFilterFromUrl("?health=ok")).toBeNull();
    expect(connectorHealthFilterFromUrl("")).toBeNull();
  });
});

function query(href: string): string {
  const at = href.indexOf("?");
  return at === -1 ? "" : href.slice(at);
}
