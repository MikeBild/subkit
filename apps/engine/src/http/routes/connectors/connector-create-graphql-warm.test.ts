// OPT-D: creating a GraphQL connector warms its schema.
//
// A GraphQL API is introspectable, so POST /v1/connectors for a `graphql`
// connector kicks off `__schema` introspection + SDL ingestion at create time
// — the authoring agent then has the relay/enum/filter shapes in context
// without a discover_connector_endpoints round-trip. The warm is bounded +
// non-fatal: it must never block creation or change the 201 response. This test
// pins (a) graphql connectors warm against their own base_url, (b) non-graphql
// connectors do NOT warm, (c) a failing warm does not fail creation.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as discoveryModule from "../../../connectors/discovery/index.ts";
import type { DiscoveryResult } from "../../../connectors/discovery/types.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;

beforeAll(async () => {
  server = await createHttpTestServer("connector-create-graphql-warm");
});

afterAll(async () => {
  await server.cleanup();
});

const SAMPLE_RESULT: DiscoveryResult = {
  source_url: "https://api.example.test/graphql",
  fetched_at: "2026-04-26T00:00:00.000Z",
  strategy: "graphql-introspect",
  spec_version: null,
  title: "Example GraphQL",
  servers: ["https://api.example.test/graphql"],
  auth_schemes: [],
  endpoints: [],
  warnings: [],
};

async function createConnector(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${server.baseUrl}/v1/connectors`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/connectors — GraphQL schema warm (OPT-D)", () => {
  test("a graphql connector warms discovery against its own base_url", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      SAMPLE_RESULT,
    );
    try {
      const res = await createConnector({
        slug: "warm-gql",
        name: "Warm GQL",
        driver: "graphql",
        base_url: "https://api.example.test/graphql",
        auth_type: "none",
      });
      expect(res.status).toBe(201);
      // The warm ran against the connector's stored base_url.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({
        base_url: "https://api.example.test/graphql",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("a non-graphql (http) connector does NOT warm", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      SAMPLE_RESULT,
    );
    try {
      const res = await createConnector({
        slug: "no-warm-http",
        name: "No Warm HTTP",
        driver: "http",
        base_url: "https://api.example.test",
        auth_type: "none",
      });
      expect(res.status).toBe(201);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("a failing warm does not fail connector creation (non-fatal)", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockRejectedValue(
      new Error("introspection endpoint unreachable"),
    );
    try {
      const res = await createConnector({
        slug: "warm-gql-fails",
        name: "Warm GQL Fails",
        driver: "graphql",
        base_url: "https://dead.example.test/graphql",
        auth_type: "none",
      });
      // Creation still succeeds — the warm failure is swallowed.
      expect(res.status).toBe(201);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
