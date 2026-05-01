// Recipe-authoring e2e smoke. Boots a real engine, creates a Stripe
// connector via REST from the builtin template, and asserts:
//   1. The connector row's `template_snapshot.recipes` carries the
//      shipped recipe roster (>= 12 entries for stripe).
//   2. Each snapshotted recipe has the slug + title + workflow shape
//      the start_workflow_from_recipe tool depends on.
//   3. The recategorized github operator_quirks is exposed via the
//      same surface (proves migration 0006 did the rewrite end-to-end).
//
// LLM is mocked at boot, so this exercises the engine + DB + REST
// surface without any real model calls.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;

beforeAll(async () => {
  env = await boot("recipe-authoring", { llm: "mock" });
}, 90_000);

afterAll(async () => {
  await shutdown(env);
}, 30_000);

function bearer(): HeadersInit {
  return {
    Authorization: `Bearer ${env.personas.admin.apiKey}`,
    "Content-Type": "application/json",
  };
}

interface ConnectorRow {
  id: string;
  slug: string;
  template_slug: string | null;
  template_snapshot: Record<string, unknown> | null;
  operator_quirks: Record<string, string>;
}

async function createConnector(body: Record<string, unknown>): Promise<ConnectorRow> {
  const res = await fetch(`${env.baseUrl}/v1/connectors`, {
    method: "POST",
    headers: bearer(),
    body: JSON.stringify(body),
  });
  expect(res.status).toBeLessThan(300);
  return (await res.json()) as ConnectorRow;
}

describe("recipe-authoring e2e", () => {
  test("creating a Stripe connector from the builtin template snapshots ≥12 recipes", async () => {
    const conn = await createConnector({
      name: "Stripe E2E",
      slug: "stripe-e2e",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      template_slug: "stripe",
      template_source: "builtin",
    });

    const snap = conn.template_snapshot;
    expect(snap).not.toBeNull();
    if (!snap) return;
    const recipes = snap.recipes as Array<Record<string, unknown>>;
    expect(Array.isArray(recipes)).toBe(true);
    expect(recipes.length).toBeGreaterThanOrEqual(12);

    // Spot-check the recipe surface every authoring tool depends on.
    const slugs = recipes.map((r) => r.slug as string);
    expect(slugs).toContain("list-customers");
    expect(slugs).toContain("create-customer");
    expect(slugs).toContain("list-charges");

    for (const r of recipes) {
      expect(typeof r.slug).toBe("string");
      expect(typeof r.title).toBe("string");
      expect(typeof r.description).toBe("string");
      expect(r.workflow).toBeDefined();
      // F1 schema fields persist into the snapshot too.
      expect(typeof r.category).toBe("string");
      expect(Array.isArray(r.tags)).toBe(true);
      expect(typeof r.difficulty).toBe("string");
      expect(typeof r.version).toBe("string");
      expect(typeof r.author).toBe("string");
    }
    // Stripe recipes derive `category: "payments"` via the F1 migration.
    expect(recipes[0]?.category).toBe("payments");
  });

  test("creating a GitHub connector exposes the recategorized operator_quirks", async () => {
    const conn = await createConnector({
      name: "GitHub E2E",
      slug: "github-e2e",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      template_slug: "github",
      template_source: "builtin",
    });

    // The connector row exposes operator_quirks directly.
    expect(conn.operator_quirks).toBeDefined();
    expect(conn.operator_quirks.error_handling ?? "").toMatch(/422/);

    // The template snapshot also carries it (stable cached source).
    const snap = conn.template_snapshot;
    expect(snap).not.toBeNull();
    if (!snap) return;
    const quirks = snap.operator_quirks as Record<string, string>;
    expect(quirks.error_handling ?? "").toMatch(/422/);
  });

  test("recipes shipped against postgres connectors include sql blocks (no-url contract)", async () => {
    const conn = await createConnector({
      name: "Postgres E2E",
      slug: "postgres-e2e",
      driver: "postgres",
      environment: "dev",
      auth_type: "none",
      dsn: "postgres://stub:stub@localhost:5432/stub",
      template_slug: "postgres",
      template_source: "builtin",
    });

    const recipes = (conn.template_snapshot?.recipes ?? []) as Array<Record<string, unknown>>;
    expect(recipes.length).toBeGreaterThanOrEqual(8);
    for (const r of recipes) {
      const wf = r.workflow as { steps?: Array<Record<string, unknown>> };
      expect(Array.isArray(wf.steps)).toBe(true);
      for (const step of wf.steps ?? []) {
        // Postgres recipes must use sql blocks, never http urls.
        expect(step.url).toBeUndefined();
        expect(step.sql).toBeDefined();
      }
    }
  });
});
