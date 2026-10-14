import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as discoveryModule from "../../../connectors/discovery/index.ts";
import type { DiscoveryResult } from "../../../connectors/discovery/types.ts";
import { apiKeys, auditLog } from "../../../db/schema/index.ts";
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
  test("a system-account key keeps its actor type through connector creation", async () => {
    const key = "wf_live_01234567890123456789012345678901";
    await server.db.insert(apiKeys).values({
      tenant_id: server.tenantId,
      system_account_id: server.systemAccountId,
      prefix: key.slice(0, 12),
      token_sha256: createHash("sha256").update(key).digest("hex"),
      scopes: ["*"],
    });
    const response = await fetch(`${server.baseUrl}/v1/connectors`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: "machine-actor",
        name: "Machine Actor",
        driver: "http",
        base_url: "https://machine.example.test",
        auth_type: "none",
      }),
    });
    expect(response.status).toBe(201);
    const connector = (await response.json()) as { id: string };
    const [audit] = await server.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.resource_id, connector.id),
          eq(auditLog.action, "connector.created"),
        ),
      );
    expect(audit).toEqual({ actor_type: "system_account", actor_id: server.systemAccountId });
  });

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
      const connector = (await res.json()) as { id: string };
      const [audit] = await server.db
        .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, server.tenantId),
            eq(auditLog.resource_id, connector.id),
            eq(auditLog.action, "connector.created"),
          ),
        );
      expect(audit).toEqual({ actor_type: "user", actor_id: server.userId });
      const [discoveryAudit] = await server.db
        .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, server.tenantId),
            eq(auditLog.action, "knowledge_source.refreshed"),
          ),
        );
      expect(discoveryAudit).toEqual({ actor_type: "user", actor_id: server.userId });
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
      expect(res.status).toBe(201);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
