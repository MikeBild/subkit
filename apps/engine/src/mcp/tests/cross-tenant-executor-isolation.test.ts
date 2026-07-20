// Cross-tenant executor isolation over the live MCP surface (C3).
//
// The dispatcher-layer variant of this invariant lives in
// `tools/tests/cross-surface-parity.test.ts`: a permissionless stub
// principal is denied by RBAC before the executor runs. This suite
// proves the SECOND defense line with real multi-tenant data: a
// tenant-A credential whose RBAC check demonstrably PASSES still
// cannot reach a tenant-B connector, because the executor's
// tenant-scoped lookup (`getConnector(ctx.tenant_id, id)`) resolves
// ids strictly inside the principal's tenant. The caller sees
// `connector_not_found` — never `policy_denied`, and never tenant-B
// data — and tenant B's audit log stays empty.

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

  // Tenant-A key whose scope ceiling contains exactly the permission
  // test_connector's RBAC override requires (`connector:test`, see
  // tools/providers/conversation.ts RBAC_OVERRIDES). `mcp:authoring` is
  // a mode marker only — it exposes the conversation tool catalog and
  // imposes no ceiling (auth/scopes.ts). The seeded user is a tenant-A
  // admin, so once the ceiling passes, `can()` allows via the builtin
  // admin short-circuit.
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
    // Control case: the exact key used for the cross-tenant attempt
    // below clears RBAC for its OWN tenant's connector. Without this,
    // a `connector_not_found` in the next test could be a false
    // negative (an RBAC misconfiguration failing closed) instead of
    // the executor WHERE-clause defense.
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
    // The tenant-scoped WHERE clause makes the foreign id unresolvable —
    // indistinguishable from a nonexistent one. A `policy_denied` here
    // would mean RBAC rejected the call before the executor ran, which
    // is the WRONG layer for this invariant (and would admit that the
    // foreign id exists).
    expect(data.error_code).toBe("connector_not_found");

    // RBAC passed, so the denial audit trail must be silent: no
    // policy.denied row anchored on the foreign connector id.
    const denied = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(and(eq(auditLog.action, "policy.denied"), eq(auditLog.resource_id, connectorB.id)));
    expect(denied[0]?.c ?? 0).toBe(0);
  });

  test("audit attribution: probe rows carry tenant A's tenant_id; tenant B's audit log stays empty", async () => {
    // The successful same-tenant probe is attributed to tenant A.
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

    // The cross-tenant attempt never reached the driver, so nothing —
    // not an invocation, not a denial — may land under tenant B.
    const tenantBRows = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, tenantB.tenantId));
    expect(tenantBRows[0]?.c ?? 0).toBe(0);
  });
});
