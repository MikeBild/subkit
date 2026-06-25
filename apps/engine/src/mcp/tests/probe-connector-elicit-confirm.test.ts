// MCP confirm-gate resolution over the wire — the regression this fixes.
//
// v7.10.4 unified the policy gate so a `confirm_before_execution` tool
// (here `probe_connector` POST/prod) returns `needs_confirm` on MCP. But
// the only documented way to satisfy it was re-issuing with
// `_meta.sk_confirm=true` — a transport field a claude.ai/ChatGPT *model*
// cannot set (it only fills the published inputSchema). So the gate was
// unsatisfiable from a model-only client: workflows/connectors couldn't be
// run and human-in-the-loop confirmations dead-ended.
//
// This test pins the two model-drivable resolution paths:
//   1. Elicitation-capable client → the server issues an in-band
//      `elicitation/create`; on accept the call executes (and on decline it
//      does not). The model does nothing special — the operator approves in
//      the client UI.
//   2. Client WITHOUT elicitation → a `confirm_tool_call` tool is surfaced;
//      the model approves the paused call by invoking it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { and, count, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;

beforeAll(async () => {
  process.env.SK_MCP_MODE = "authoring";
  suite = await startMcpTestSuite("probe-connector-elicit-confirm");
  mock = await createMockServer((_req, res) => {
    jsonResponse(res, 201, { id: "created" });
  });
});

afterAll(async () => {
  await mock.close();
  await suite.cleanup();
  delete process.env.SK_MCP_MODE;
});

// Connect a client that advertises the `elicitation` capability and
// answers `elicitation/create` according to `decision`.
async function connectElicitClient(decision: "accept" | "decline"): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${suite.http.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${suite.http.apiKey}` } },
  });
  const client = new Client(
    { name: "subkit-mcp-elicit-tests", version: "0.0.0" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(ElicitRequestSchema, async () =>
    decision === "accept"
      ? { action: "accept" as const, content: { confirm: true } }
      : { action: "decline" as const },
  );
  await client.connect(transport as unknown as Transport);
  return client;
}

describe("probe_connector confirm gate — resolvable over MCP", () => {
  test("elicitation-capable client: in-band approve → call executes, APPROVAL_APPROVED written", async () => {
    await suite.seedConnector({
      slug: "elicit-accept",
      environment: "prod",
      base_url: mock.baseUrl,
    });

    const approvedBaseline = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, "approval.approved")),
      );

    const client = await connectElicitClient("accept");
    try {
      // An elicitation-capable client must NOT be offered the fallback tool.
      const listed = await client.listTools();
      expect(listed.tools.some((t) => t.name === "confirm_tool_call")).toBe(false);

      const result = await client.callTool({
        name: "probe_connector",
        arguments: {
          connector_slug: "elicit-accept",
          method: "POST",
          path: "/orders",
          environment: "prod",
          body: { qty: 1 },
        },
      });

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
        status_code?: number;
        persistence?: string;
      };
      // Executed, not a needs_confirm envelope.
      expect(payload.status_code).toBe(201);
      expect(payload.persistence).toBe("none");
    } finally {
      await client.close();
    }

    const approvedAfter = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, "approval.approved")),
      );
    expect((approvedAfter[0]?.c ?? 0) - (approvedBaseline[0]?.c ?? 0)).toBe(1);
  });

  test("elicitation-capable client: in-band decline → call is NOT executed", async () => {
    await suite.seedConnector({
      slug: "elicit-decline",
      environment: "prod",
      base_url: mock.baseUrl,
    });

    const client = await connectElicitClient("decline");
    try {
      const result = await client.callTool({
        name: "probe_connector",
        arguments: {
          connector_slug: "elicit-decline",
          method: "POST",
          path: "/orders",
          environment: "prod",
          body: { qty: 1 },
        },
      });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
        status?: string;
        status_code?: number;
      };
      expect(payload.status).toBe("declined");
      // No HTTP execution happened.
      expect(payload.status_code).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  test("client without elicitation: confirm_tool_call fallback approves the paused call", async () => {
    await suite.seedConnector({
      slug: "fallback-confirm",
      environment: "prod",
      base_url: mock.baseUrl,
    });

    const client = await suite.connect();

    // Non-elicitation clients are offered the responder tool.
    const listed = await client.listTools();
    expect(listed.tools.some((t) => t.name === "confirm_tool_call")).toBe(true);

    const probeArgs = {
      connector_slug: "fallback-confirm",
      method: "POST",
      path: "/orders",
      environment: "prod",
      body: { qty: 3 },
    };

    // First call → needs_confirm envelope.
    const first = await client.callTool({ name: "probe_connector", arguments: probeArgs });
    const firstPayload = JSON.parse((first.content as Array<{ text: string }>)[0]!.text) as {
      policy_mode?: string;
      tool_call_id?: string;
    };
    expect(firstPayload.policy_mode).toBe("confirm_before_execution");
    const toolCallId = firstPayload.tool_call_id!;
    expect(toolCallId).toBeTruthy();

    const approvedBaseline = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, "approval.approved")),
      );

    // Approve via the fallback responder tool.
    const approved = await client.callTool({
      name: "confirm_tool_call",
      arguments: { tool: "probe_connector", arguments: probeArgs, confirm_id: toolCallId },
    });
    expect(approved.isError).toBeFalsy();
    const approvedPayload = JSON.parse((approved.content as Array<{ text: string }>)[0]!.text) as {
      status_code?: number;
    };
    expect(approvedPayload.status_code).toBe(201);

    // APPROVAL_APPROVED correlates to the original tool_call_id.
    const rows = await suite.http.db
      .select({ id: auditLog.resource_id })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, "approval.approved")),
      );
    expect(rows.length).toBe((approvedBaseline[0]?.c ?? 0) + 1);
    expect(rows[rows.length - 1]?.id).toBe(toolCallId);
  });
});
