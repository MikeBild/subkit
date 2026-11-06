import { describe, expect, test } from "bun:test";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { EngineClient, type FetchLike } from "../engine-client.ts";

type Schemas = components["schemas"];

const CONNECTOR_ID = "5eed0003-0000-4000-8000-000000000001";

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

function fakeEngine(reply: unknown): { client: EngineClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    seen.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    client: new EngineClient({ engine_url: "http://engine.test", api_key: "k", fetchImpl }),
    seen,
  };
}

describe("EngineClient connector methods follow the contract", () => {
  test("listConnectorTemplates sends no query, which the contract does not declare", async () => {
    const reply = { items: [] } satisfies Schemas["ConnectorTemplateListResponse"];
    const { client, seen } = fakeEngine(reply);
    expect(await client.listConnectorTemplates()).toEqual(reply);
    expect(seen).toEqual([
      { method: "GET", url: "http://engine.test/v1/connector-templates", body: undefined },
    ]);
  });

  test("searchConnectorDocs sends q and omits an unset limit", async () => {
    const reply = { items: [] } satisfies Schemas["ConnectorDocsSearchResponse"];
    const { client, seen } = fakeEngine(reply);
    await client.searchConnectorDocs(CONNECTOR_ID, "refunds");
    await client.searchConnectorDocs(CONNECTOR_ID, "refunds", 5);
    expect(seen.map((s) => s.url)).toEqual([
      `http://engine.test/v1/connectors/${CONNECTOR_ID}/docs/search?q=refunds`,
      `http://engine.test/v1/connectors/${CONNECTOR_ID}/docs/search?q=refunds&limit=5`,
    ]);
  });

  test("createConnectorFromTemplate sends an empty ConnectorFromTemplateBody by default", async () => {
    const { client, seen } = fakeEngine({});
    await client.createConnectorFromTemplate("stripe");
    expect(seen).toEqual([
      {
        method: "POST",
        url: "http://engine.test/v1/connectors/from-template/stripe",
        body: {} satisfies Schemas["ConnectorFromTemplateBody"],
      },
    ]);
  });
});
