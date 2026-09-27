import { describe, expect, test } from "bun:test";
import { connectorsHref } from "@/app/links";
import { stringValue } from "@/components/cockpit/table-columns";
import {
  connectorHealthFilterFromUrl,
  connectorNeedsAttention,
  workflowsByConnector,
} from "@/pages/connectors-model";

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
  test("enabled and not ok is the engine's own complement", () => {
    expect(connectorNeedsAttention({ enabled: true, health_state: "needs_reauth" })).toBe(true);
    expect(connectorNeedsAttention({ enabled: true, health_state: "degraded" })).toBe(true);
    expect(connectorNeedsAttention({ enabled: true, health_state: "needs_update" })).toBe(true);
    expect(connectorNeedsAttention({ enabled: true, health_state: "ok" })).toBe(false);
  });

  test("a disabled connector is outside the ratio, however unhealthy", () => {
    expect(connectorNeedsAttention({ enabled: false, health_state: "needs_reauth" })).toBe(false);
  });

  test("the list a red tile opens holds exactly the unhealthy enabled ones", () => {
    const rows = [
      { id: "a", enabled: true, health_state: "ok", needs_reauth: false },
      { id: "b", enabled: true, health_state: "needs_reauth", needs_reauth: true },
      { id: "c", enabled: false, health_state: "degraded", needs_reauth: false },
      { id: "d", enabled: true, health_state: "ok", needs_reauth: false },
    ];
    expect(rows.filter(connectorNeedsAttention).map((row) => row.id)).toEqual(["b"]);
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
