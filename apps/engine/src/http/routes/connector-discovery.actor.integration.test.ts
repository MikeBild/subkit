import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as discoveryModule from "../../connectors/discovery/index.ts";
import { apiKeys, auditLog } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let server: HttpTestServer;

beforeAll(async () => {
  server = await createHttpTestServer("connector-discovery-actor");
});

afterAll(async () => {
  await server.cleanup();
});

test("connector discovery attributes source creation and refresh to the authenticated user", async () => {
  const discovery = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue({
    source_url: "https://api.example.test/openapi.json",
    fetched_at: "2026-10-12T00:00:00.000Z",
    strategy: "openapi-direct",
    spec_version: "openapi-3",
    title: "Example API",
    servers: ["https://api.example.test"],
    auth_schemes: [],
    endpoints: [],
    warnings: [],
  });

  try {
    for (const force_refresh of [false, true]) {
      const response = await fetch(`${server.baseUrl}/v1/connectors/discover`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${server.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ base_url: "https://api.example.test", force_refresh }),
      });
      expect(response.status).toBe(200);
    }

    const systemKey = "wf_live_connector_discovery_system_actor_test";
    await server.db.insert(apiKeys).values({
      tenant_id: server.tenantId,
      system_account_id: server.systemAccountId,
      prefix: systemKey.slice(0, 12),
      token_sha256: createHash("sha256").update(systemKey).digest("hex"),
      scopes: ["*"],
    });
    const systemResponse = await fetch(`${server.baseUrl}/v1/connectors/discover`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${systemKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ base_url: "https://system.example.test" }),
    });
    expect(systemResponse.status).toBe(200);
  } finally {
    discovery.mockRestore();
  }

  const rows = await server.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, server.tenantId),
        eq(auditLog.action, "knowledge_source.refreshed"),
      ),
    );

  expect(rows).toHaveLength(3);
  expect(rows.filter((row) => row.actor_type === "user")).toHaveLength(2);
  expect(rows.filter((row) => row.actor_type === "system_account")).toEqual([
    { actor_type: "system_account", actor_id: server.systemAccountId },
  ]);
  expect(
    rows.filter((row) => row.actor_type === "user").every((row) => row.actor_id === server.userId),
  ).toBe(true);
});
