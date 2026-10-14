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
    status: "all" as const,
    category: "all",
    connector: "",
    health: "not_ok" as const,
    sort: "name",
    order: "asc" as const,
  };

  test("the narrowing is the engine's; paging is left to the list", () => {
    const params = catalogListParams("connectors", state);
    expect(params.health).toBe("not_ok");
    expect(params).not.toHaveProperty("limit");
    expect(params).not.toHaveProperty("offset");
    expect(params).not.toHaveProperty("enabled");
  });

  test("kind filtering reaches the server before pagination and stays connector-only", () => {
    for (const kind of ["oauth", "mcp", "key"] as const) {
      expect(catalogListParams("connectors", { ...state, kind }).kind).toBe(kind);
      expect(catalogListParams("workflows", { ...state, kind })).not.toHaveProperty("kind");
    }
    expect(catalogListParams("connectors", { ...state, kind: "all" })).not.toHaveProperty("kind");
  });

  test("only the connector list carries it", () => {
    expect(catalogListParams("workflows", state)).not.toHaveProperty("health");
    expect(catalogListParams("connectors", { ...state, health: null })).not.toHaveProperty(
      "health",
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
