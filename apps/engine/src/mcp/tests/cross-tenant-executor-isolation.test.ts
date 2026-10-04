import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, count, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;
let client: Client;
let tenantB: { tenantId: string; userId: string };
let connectorA: { id: string };
let connectorB: { id: string };

beforeAll(async () => {
  suite = await startMcpTestSuite("cross-tenant-iso");
  mock = await createMockServer((_req, res) => {
    jsonResponse(res, 200, { ok: true });
  });

  tenantB = await suite.seedTenant("iso");
  connectorA = await suite.seedConnector({ slug: "iso-tenant-a", base_url: mock.baseUrl });
  connectorB = await suite.seedConnectorForTenant(tenantB.tenantId, {
    slug: "iso-tenant-b",
    base_url: mock.baseUrl,
  });

  const key = await suite.issueApiKeyForTenant(suite.http.tenantId, suite.http.userId, [
    "connector:test",
    "mcp:authoring",
  ]);
  client = await suite.connectWithApiKey(key.plaintext);
});

afterAll(async () => {
  await mock.close();
  await suite.cleanup();
});

describe("mcp test_connector — cross-tenant executor isolation", () => {
  test("same-tenant probe succeeds with the scoped key — proves the RBAC layer passes", async () => {
    const result = await client.callTool({
      name: "test_connector",
      arguments: { connector_id: connectorA.id },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as { ok?: boolean };
    expect(data.ok).toBe(true);
  });

  test("tenant-B connector_id → connector_not_found from the executor, NOT policy_denied", async () => {
    const result = await client.callTool({
      name: "test_connector",
      arguments: { connector_id: connectorB.id },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as { error_code?: string };
    expect(data.error_code).toBe("connector_not_found");

    const denied = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(and(eq(auditLog.action, "policy.denied"), eq(auditLog.resource_id, connectorB.id)));
    expect(denied[0]?.c ?? 0).toBe(0);
  });

  test("audit attribution: probe rows carry tenant A's tenant_id; tenant B's audit log stays empty", async () => {
    const invoked = await suite.http.db
      .select({ tenant_id: auditLog.tenant_id })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "connector.invoked"), eq(auditLog.resource_id, connectorA.id)),
      );
    expect(invoked.length).toBeGreaterThanOrEqual(1);
    for (const row of invoked) {
      expect(row.tenant_id).toBe(suite.http.tenantId);
    }

    const tenantBRows = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, tenantB.tenantId));
    expect(tenantBRows[0]?.c ?? 0).toBe(0);
  });
});
