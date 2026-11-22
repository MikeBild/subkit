import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, cli, type E2EEnv, expectSuccess, parseJson, shutdown } from "./setup.ts";

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

    const slugs = recipes.map((r) => r.slug as string);
    expect(slugs).toContain("list-customers");
    expect(slugs).toContain("create-customer");
    expect(slugs).toContain("list-charges");

    for (const r of recipes) {
      expect(typeof r.slug).toBe("string");
      expect(typeof r.title).toBe("string");
      expect(typeof r.description).toBe("string");
      expect(r.workflow).toBeDefined();
      expect(typeof r.category).toBe("string");
      expect(Array.isArray(r.tags)).toBe(true);
      expect(typeof r.difficulty).toBe("string");
      expect(typeof r.version).toBe("string");
      expect(typeof r.author).toBe("string");
    }
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

    expect(conn.operator_quirks).toBeDefined();
    expect(conn.operator_quirks.error_handling ?? "").toMatch(/422/);

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
        expect(step.url).toBeUndefined();
        expect(step.sql).toBeDefined();
      }
    }
  });
});

describe("subkit workflows create --from-recipe", () => {
  test("names the missing connector, then creates the solution once it exists", async () => {
    const refused = await cli(["workflows", "create", "--from-recipe", "webhook-to-slack"], {
      env,
    });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("subkit connectors create --template slack");

    const slack = await createConnector({
      name: "Slack E2E",
      slug: "slack-e2e",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      template_slug: "slack",
      template_source: "builtin",
    });
    const created = await cli(
      ["workflows", "create", "--from-recipe", "webhook-to-slack", "--json"],
      { env, timeout: 60_000 },
    );
    expectSuccess(created, "subkit workflows create --from-recipe");
    const workflow = parseJson<{ id: string; slug: string }>(created);
    expect(workflow.slug).toBe("webhook-to-slack");

    const res = await fetch(`${env.baseUrl}/v1/workflows/${workflow.id}`, { headers: bearer() });
    expect(JSON.stringify(await res.json())).toContain(slack.id);
  }, 90_000);
});
