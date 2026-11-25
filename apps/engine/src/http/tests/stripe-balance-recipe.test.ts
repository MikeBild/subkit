import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const RECIPE_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const transactions = Array.from({ length: 101 }, (_, index) => ({
  id: `txn_${index + 1}`,
  object: "balance_transaction",
  net: index + 97,
  status: index === 100 ? "pending" : "available",
}));

interface ProviderCall {
  starting_after: string | null;
  status: number;
}

let ctx: HttpTestServer;
let stripeMock: MockServer;
let providerCalls: ProviderCall[] = [];

beforeAll(async () => {
  ctx = await createHttpTestServer("stripe_balance_recipe");
  stripeMock = await createMockServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stripe.mock");
    const cursor = url.searchParams.get("starting_after");
    const reply = (status: number, body: unknown) => {
      providerCalls.push({ starting_after: cursor, status });
      jsonResponse(res, status, body);
    };
    if (url.pathname !== "/v1/balance_transactions") return reply(404, { error: "not found" });
    const pageLimit = Number(url.searchParams.get("limit") ?? "10");
    const cursorIndex = cursor ? transactions.findIndex((row) => row.id === cursor) : -1;
    if (cursor && cursorIndex < 0) return reply(400, { error: "invalid starting_after cursor" });
    const start = cursorIndex + 1;
    const data = transactions.slice(start, start + pageLimit);
    return reply(200, {
      object: "list",
      url: url.pathname,
      has_more: start + data.length < transactions.length,
      data,
    });
  });
});

afterAll(async () => {
  await stripeMock.close();
  await ctx.cleanup();
});

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  expect(response.status).toBeLessThan(300);
  return (await response.json()) as T;
}

const netByStatus = (rows: typeof transactions, status: string) =>
  rows.filter((row) => row.status === status).reduce((total, row) => total + row.net, 0);

describe("stock stripe list-balance-transactions recipe (#540)", () => {
  test("follows the cursor once and stops when Stripe reports has_more false", async () => {
    const connector = await api<{ id: string }>("/v1/connectors", {
      method: "POST",
      body: {
        name: "Synthetic Stripe",
        slug: "stripe",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        template_slug: "stripe",
        base_url: `${stripeMock.baseUrl}/v1`,
      },
    });
    const recipe = await api<{ workflow: Record<string, unknown> }>(
      "/v1/connector-templates/stripe/recipes/list-balance-transactions",
    );
    const definition = {
      ...JSON.parse(JSON.stringify(recipe.workflow).replaceAll(RECIPE_PLACEHOLDER, connector.id)),
      slug: "stripe-balance-reconcile",
    };
    const workflow = await api<{ id: string }>("/v1/workflows", {
      method: "POST",
      body: definition,
    });
    providerCalls = [];
    const run = await api<{ execution_id: string; status: string; output: typeof transactions }>(
      "/v1/executions",
      {
        method: "POST",
        body: { source: "saved", workflow_id: workflow.id, idempotency_key: "balance-reconcile" },
      },
    );
    const steps = await api<{ items: Array<{ step_key: string; status: string }> }>(
      `/v1/executions/${run.execution_id}/steps`,
    );

    expect(run.status).toBe("succeeded");
    expect(steps.items.map((step) => [step.step_key, step.status])).toEqual([
      ["list", "succeeded"],
    ]);
    expect(providerCalls).toEqual([
      { starting_after: null, status: 200 },
      { starting_after: "txn_100", status: 200 },
    ]);
    const balanceRows = run.output.filter((row) => row.object === "balance_transaction");
    expect(balanceRows.map((row) => row.id)).toEqual(transactions.map((row) => row.id));
    expect({
      available: netByStatus(balanceRows, "available"),
      pending: netByStatus(balanceRows, "pending"),
    }).toEqual({ available: 14_650, pending: 197 });
  });
});
