// The MCP client is not an approval authority. Real transport + Postgres prove
// that a write waits for a human grant and its stored call executes once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, count, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { grantApproval } from "../../tools/approval.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;
let hits = 0;

beforeAll(async () => {
  process.env.SK_MCP_MODE = "authoring";
  suite = await startMcpTestSuite("probe-connector-prod-confirm");
  mock = await createMockServer((_req, res) => {
    hits++;
    jsonResponse(res, 201, { id: "created" });
  });
});

afterAll(async () => {
  await mock?.close();
  await suite?.cleanup();
  delete process.env.SK_MCP_MODE;
});

function body(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
    status?: string;
    status_code?: number;
    error_code?: string;
    tool_call_id?: string;
    approval_url?: string | null;
    resume?: string;
  };
}

describe("probe_connector — local approval for a production write", () => {
  test("no write before the human grant; the bound call runs once after it", async () => {
    await suite.seedConnector({
      slug: "prod-post-probe",
      environment: "prod",
      base_url: mock.baseUrl,
    });
    const client = await suite.connect();
    const initialHits = hits;
    const args = {
      connector_slug: "prod-post-probe",
      method: "POST",
      path: "/orders",
      environment: "prod",
      body: { qty: 1 },
    };
    const pending = body(await client.callTool({ name: "probe_connector", arguments: args }));
    expect(pending.status).toBe("needs_confirm");
    expect(pending.status_code).toBeUndefined();
    expect(pending.tool_call_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(pending.resume).toContain("confirm_tool_call");
    expect(hits).toBe(initialHits);
    const trigger = { tool: "probe_connector", confirm_id: pending.tool_call_id! };
    const denied = body(await client.callTool({ name: "confirm_tool_call", arguments: trigger }));
    expect(denied.error_code).toBe("approval_not_granted");
    expect(hits).toBe(initialHits);

    // Fixture substitutes only the upstream human decision. This is the real
    // portal's transactional grant function, not a model-controlled tool.
    const granted = await grantApproval({
      db: suite.http.db,
      approval_id: trigger.confirm_id,
      tenant_id: suite.http.tenantId,
      granted_by_user_id: suite.http.userId,
      via: "portal",
    });
    expect(granted.ok).toBe(true);
    // Replacement arguments cannot expand a granted call or consume its handle.
    const replacement = body(
      await client.callTool({
        name: "confirm_tool_call",
        arguments: { ...trigger, arguments: { path: "/different" } },
      }),
    );
    expect(replacement.error_code).toBe("invalid_args");
    expect(hits).toBe(initialHits);
    const executed = await client.callTool({ name: "confirm_tool_call", arguments: trigger });
    expect(executed.isError).toBeFalsy();
    expect(body(executed).status_code).toBe(201);
    expect(hits).toBe(initialHits + 1);
    const duplicate = await client.callTool({ name: "confirm_tool_call", arguments: trigger });
    expect(duplicate.isError).toBe(true);
    expect(hits).toBe(initialHits + 1);
    for (const action of ["approval.requested", "approval.granted", "approval.approved"]) {
      const rows = await suite.http.db
        .select({ c: count() })
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, action)));
      expect(rows[0]?.c).toBe(1);
    }
  });

  test("a caller-authored confirmation marker cannot authorize a write", async () => {
    await suite.seedConnector({
      slug: "prod-post-probe-marker",
      environment: "prod",
      base_url: mock.baseUrl,
    });
    const client = await suite.connect();
    const initialHits = hits;
    const result = await client.callTool({
      name: "probe_connector",
      arguments: {
        connector_slug: "prod-post-probe-marker",
        method: "POST",
        path: "/orders",
        environment: "prod",
      },
      _meta: { sk_confirm: true, sk_confirm_id: "11111111-1111-1111-1111-111111111111" },
    });
    expect(result.isError).toBe(true);
    expect(body(result).error_code).toBe("unknown_confirmation");
    expect(hits).toBe(initialHits);
  });
});
