// Contract: every column the catalog list commands render must be a real
// property of the engine's list item.
//
// Regression target: `sk workflows list` rendered a `status` column that the
// engine never returned — it calls the field `lifecycle` — so the column was
// blank on every row from the day it was added, and nothing failed. Checking
// the column names against the committed OpenAPI schema turns that silent
// class of bug into a test failure.

import { describe, expect, test } from "bun:test";
import openapi from "@cli-core/engine-api/openapi.json" with { type: "json" };
import {
  CONNECTOR_LIST_COLUMNS,
  CONNECTOR_SYNTHESISED_COLUMNS,
  WORKFLOW_LIST_COLUMNS,
  WORKFLOW_SYNTHESISED_COLUMNS,
} from "./list-columns.ts";

type Schema = {
  properties?: Record<string, unknown>;
  allOf?: Schema[];
  $ref?: string;
};

const schemas = (openapi as { components: { schemas: Record<string, Schema> } }).components.schemas;

/** Collect property names through `allOf` composition and `$ref` indirection. */
function propertiesOf(name: string, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(name)) return out;
  seen.add(name);
  const schema = schemas[name];
  if (!schema) return out;
  for (const key of Object.keys(schema.properties ?? {})) out.add(key);
  for (const branch of schema.allOf ?? []) {
    if (branch.$ref) {
      const ref = branch.$ref.split("/").pop();
      if (ref) for (const key of propertiesOf(ref, seen)) out.add(key);
    }
    for (const key of Object.keys(branch.properties ?? {})) out.add(key);
  }
  return out;
}

describe("catalog list columns match the engine schema", () => {
  test("the list-item schemas resolve to real properties", () => {
    // Guards the test itself: if `allOf`/`$ref` resolution ever silently
    // returns nothing, the assertions below would pass vacuously.
    expect(propertiesOf("WorkflowListItem").size).toBeGreaterThan(5);
    expect(propertiesOf("ConnectorListItem").size).toBeGreaterThan(5);
  });

  test("every workflow column exists on WorkflowListItem, or is synthesised", () => {
    const available = propertiesOf("WorkflowListItem");
    const missing = WORKFLOW_LIST_COLUMNS.filter(
      (c) => !available.has(c) && !WORKFLOW_SYNTHESISED_COLUMNS.includes(c),
    );
    expect(missing).toEqual([]);
  });

  test("the trigger column is synthesised from the effective trigger, not the definition", () => {
    const available = propertiesOf("WorkflowListItem");
    expect(available.has("effective_trigger")).toBe(true);
    expect(available.has("schedule")).toBe(true);
    expect(WORKFLOW_LIST_COLUMNS).not.toContain("trigger");
    for (const c of WORKFLOW_SYNTHESISED_COLUMNS) expect(available.has(c)).toBe(false);
  });

  test("every connector column exists on ConnectorListItem, or is synthesised", () => {
    const available = propertiesOf("ConnectorListItem");
    const missing = CONNECTOR_LIST_COLUMNS.filter(
      (c) => !available.has(c) && !CONNECTOR_SYNTHESISED_COLUMNS.includes(c),
    );
    expect(missing).toEqual([]);
  });

  test("the field that caused the bug is named lifecycle, not status", () => {
    const available = propertiesOf("WorkflowListItem");
    expect(available.has("lifecycle")).toBe(true);
    expect(available.has("status")).toBe(false);
    expect(WORKFLOW_LIST_COLUMNS).toContain("lifecycle");
    expect(WORKFLOW_LIST_COLUMNS).not.toContain("status");
  });

  test("the grouping columns are rendered", () => {
    expect(WORKFLOW_LIST_COLUMNS).toContain("connectors");
    expect(propertiesOf("WorkflowListItem").has("category")).toBe(true);
    expect(propertiesOf("ConnectorListItem").has("category")).toBe(true);
  });
});
