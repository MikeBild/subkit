// Route contract for the four driver-dispatched connector methods.
//
// `sk connectors enable / disable / mcp-inspect / mcp-authorize` are each one
// client method away from an HTTP path. The command tests pin the verb→method
// wiring; this pins method→path, which is the half that breaks silently: a
// wrong path is a 404 nobody sees until an operator runs the verb.

import { describe, expect, test } from "bun:test";

import { EngineClient, type FetchLike } from "../engine-client.ts";

const BASE = "https://engine.example.test";
const ID = "11111111-1111-4111-8111-111111111111";

function clientCapturing(
  captured: { url: string; method: string }[],
  body: unknown = { ok: true },
): EngineClient {
  const fetchImpl: FetchLike = async (input, init) => {
    captured.push({ url: String(input), method: String(init?.method ?? "GET") });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return new EngineClient({ engine_url: BASE, api_key: "test-key", tenant: "t-1", fetchImpl });
}

describe("EngineClient connector enablement", () => {
  test("enableConnector posts to the connector's enable path", async () => {
    const captured: { url: string; method: string }[] = [];
    await clientCapturing(captured).enableConnector(ID);
    expect(captured).toEqual([{ url: `${BASE}/v1/connectors/${ID}/enable`, method: "POST" }]);
  });

  test("disableConnector posts to the connector's disable path", async () => {
    const captured: { url: string; method: string }[] = [];
    await clientCapturing(captured).disableConnector(ID);
    expect(captured).toEqual([{ url: `${BASE}/v1/connectors/${ID}/disable`, method: "POST" }]);
  });
});

describe("EngineClient mcp-driver connector methods", () => {
  test("inspectMcpConnector posts to the connector's mcp/inspect path", async () => {
    const captured: { url: string; method: string }[] = [];
    const result = await clientCapturing(captured, {
      connector_id: ID,
      slug: "rovo",
      tools: [{ name: "search" }],
      capabilities: { tools: true, resources: false, prompts: false },
      instructions: null,
      server_version: null,
    }).inspectMcpConnector(ID);
    expect(captured).toEqual([{ url: `${BASE}/v1/connectors/${ID}/mcp/inspect`, method: "POST" }]);
    expect(result.slug).toBe("rovo");
  });

  test("authorizeMcpConnector posts to the connector's mcp/authorize path", async () => {
    const captured: { url: string; method: string }[] = [];
    const result = await clientCapturing(captured, {
      authorization_url: "https://idp.example.test/authorize?client_id=abc",
      state: "state-1",
    }).authorizeMcpConnector(ID);
    expect(captured).toEqual([
      { url: `${BASE}/v1/connectors/${ID}/mcp/authorize`, method: "POST" },
    ]);
    expect(result.authorization_url).toContain("https://idp.example.test/authorize");
  });

  // The mcp authorize path is NOT the connector OAuth path. They discover
  // the authorization server two different ways (config-declared issuer vs
  // RFC 9728 protected-resource metadata), so routing one at the other
  // yields a misleading error rather than a browser flow.
  test("mcp/authorize is a different path from the connector oauth/start flow", async () => {
    const captured: { url: string; method: string }[] = [];
    await clientCapturing(captured, {
      authorization_url: "https://idp.example.test/authorize",
      state: "s",
    }).authorizeMcpConnector(ID);
    expect(captured[0]?.url).not.toContain("/oauth/start");
  });

  test("a connector id with URL-special characters is encoded, not interpolated raw", async () => {
    const captured: { url: string; method: string }[] = [];
    await clientCapturing(captured).inspectMcpConnector("a/b?c");
    expect(captured[0]?.url).toBe(`${BASE}/v1/connectors/a%2Fb%3Fc/mcp/inspect`);
  });
});
