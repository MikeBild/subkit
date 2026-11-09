import { expect, test } from "bun:test";
import { renderInvokeSnippet } from "./invoke-snippet.ts";

const options = {
  engineUrl: "https://example.test",
  workflowId: "orders",
  environment: "prod" as const,
};

test("Node snippets remain executable when unknown leaf values cannot be JSON encoded", async () => {
  const snippet = renderInvokeSnippet({
    ...options,
    lang: "node",
    input: { callback: () => {}, symbol: Symbol("not-json") },
  });
  const calls: Array<{ url: string; body: string }> = [];
  const run = new (Object.getPrototypeOf(async () => {}).constructor)(
    "fetch",
    "process",
    "console",
    snippet,
  );
  await run(
    async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return { json: async () => ({ ok: true }) };
    },
    { env: { SK_API_KEY: "test-key" } },
    { log: () => {} },
  );
  expect(calls).toEqual([
    {
      url: "https://example.test/v1/executions",
      body: JSON.stringify({
        source: "saved",
        workflow_id: "orders",
        input: { callback: null, symbol: null },
      }),
    },
  ]);
});

test("Python request literals encode nullish and nonfinite input as None", () => {
  const snippet = renderInvokeSnippet({
    ...options,
    lang: "python",
    input: { nil: null, missing: undefined, nan: NaN, positive: Infinity, negative: -Infinity },
  });
  expect(
    snippet
      .split("\n")
      .find((line) => line.trimStart().startsWith("json="))
      ?.trim(),
  ).toBe(
    'json={"source": "saved", "workflow_id": "orders", "input": {"nil": None, "missing": None, "nan": None, "positive": None, "negative": None}},',
  );
});
