// MCP confirm-gate resolution over the wire — the regression this fixes.
//
// Unifying the policy gate made a `confirm_before_execution` tool (here
// `probe_connector` POST/prod) return `needs_confirm` on MCP. But the only
// documented way to satisfy it was re-issuing with `_meta.sk_confirm=true` —
// a transport field a model-only client cannot set (it only fills the
// published inputSchema). So the gate was unsatisfiable from a model-only
// client: workflows/connectors couldn't be run and human-in-the-loop
// confirmations dead-ended.
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
// answers `elicitation/create` according to `decision`. The returned
// `elicitCount` ref lets a test assert how many in-band prompts fired —
// used to prove the bridge is SKIPPED when an out-of-band confirm token
// is supplied.
async function connectElicitClient(
  decision: "accept" | "decline",
): Promise<{ client: Client; elicitCount: { n: number } }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${suite.http.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${suite.http.apiKey}` } },
  });
  const client = new Client(
    { name: "subkit-mcp-elicit-tests", version: "0.0.0" },
    { capabilities: { elicitation: {} } },
  );
  const elicitCount = { n: 0 };
  client.setRequestHandler(ElicitRequestSchema, async () => {
    elicitCount.n += 1;
    return decision === "accept"
      ? { action: "accept" as const, content: { confirm: true } }
      : { action: "decline" as const };
  });
  await client.connect(transport as unknown as Transport);
  return { client, elicitCount };
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

    const { client } = await connectElicitClient("accept");
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

  test("elicitation-capable client: in-band decline → NOT executed, but durable confirm envelope is returned (gate stays reachable)", async () => {
    await suite.seedConnector({
      slug: "elicit-decline",
      environment: "prod",
      base_url: mock.baseUrl,
    });

    const { client } = await connectElicitClient("decline");
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
        policy_mode?: string;
        tool_call_id?: string;
        status_code?: number;
      };
      // Declining the in-band prompt must NOT execute the call...
      expect(payload.status_code).toBeUndefined();
      // ...but it returns the durable, audit-backed confirm envelope so a
      // programmatic / non-interactive driver can still satisfy the gate
      // out-of-band via confirm_tool_call / _meta.sk_confirm. Pre-fix this
      // was a terminal "declined" payload with no usable tool_call_id —
      // the deadlock this change closes.
      expect(payload.policy_mode).toBe("confirm_before_execution");
      expect(payload.tool_call_id).toMatch(/^[0-9a-f-]{36}$/);
      const meta = result._meta as { subkit?: { confirm?: { tool_call_id?: string } } };
      expect(meta?.subkit?.confirm?.tool_call_id).toBe(payload.tool_call_id);
    } finally {
      await client.close();
    }
  });

  test("elicitation-capable client: out-of-band _meta.sk_confirm bypasses the bridge and executes via the durable token", async () => {
    await suite.seedConnector({
      slug: "elicit-fallback",
      environment: "prod",
      base_url: mock.baseUrl,
    });

    // The handler DECLINES every in-band prompt and counts how many fired.
    // After the first (declined) call hands back the durable id, the
    // re-issue carries _meta.sk_confirm — the bridge MUST be skipped (no
    // second prompt) and verifyMcpConfirmation adjudicates the token.
    const { client, elicitCount } = await connectElicitClient("decline");
    const probeArgs = {
      connector_slug: "elicit-fallback",
      method: "POST" as const,
      path: "/orders",
      environment: "prod" as const,
      body: { qty: 5 },
    };
    try {
      const first = await client.callTool({ name: "probe_connector", arguments: probeArgs });
      const firstPayload = JSON.parse((first.content as Array<{ text: string }>)[0]!.text) as {
        tool_call_id?: string;
        status_code?: number;
      };
      expect(firstPayload.status_code).toBeUndefined();
      const toolCallId = firstPayload.tool_call_id!;
      expect(toolCallId).toBeTruthy();
      expect(elicitCount.n).toBe(1);

      const approvedBaseline = await suite.http.db
        .select({ c: count() })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, suite.http.tenantId),
            eq(auditLog.action, "approval.approved"),
          ),
        );

      // Re-issue with the out-of-band confirm marker. With the bridge as a
      // FALLBACK, the resolver is not attached, so no second elicitation
      // prompt fires and the audit-backed token is adjudicated directly.
      const second = await client.callTool({
        name: "probe_connector",
        arguments: probeArgs,
        _meta: { sk_confirm: true, sk_confirm_id: toolCallId },
      });
      expect(second.isError).toBeFalsy();
      const secondPayload = JSON.parse((second.content as Array<{ text: string }>)[0]!.text) as {
        status_code?: number;
      };
      expect(secondPayload.status_code).toBe(201);
      // The decisive assertion: the in-band bridge was NOT re-invoked.
      expect(elicitCount.n).toBe(1);

      const approvedAfter = await suite.http.db
        .select({ c: count() })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, suite.http.tenantId),
            eq(auditLog.action, "approval.approved"),
          ),
        );
      expect((approvedAfter[0]?.c ?? 0) - (approvedBaseline[0]?.c ?? 0)).toBe(1);
    } finally {
      await client.close();
    }
  });

  test("elicitation-capable client: a self-minted sk_confirm_id still fails the gate (no execution)", async () => {
    await suite.seedConnector({
      slug: "elicit-forged",
      environment: "prod",
      base_url: mock.baseUrl,
    });

    const { client, elicitCount } = await connectElicitClient("decline");
    try {
      const res = await client.callTool({
        name: "probe_connector",
        arguments: {
          connector_slug: "elicit-forged",
          method: "POST",
          path: "/orders",
          environment: "prod",
          body: { qty: 1 },
        },
        _meta: { sk_confirm: true, sk_confirm_id: "00000000-0000-0000-0000-000000000000" },
      });
      // The bridge is skipped (a confirm marker is present) but the token is
      // forged → verifyMcpConfirmation rejects it. No execution, no prompt.
      expect(res.isError).toBe(true);
      const payload = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
        error_code?: string;
        status_code?: number;
      };
      expect(payload.error_code).toBe("unknown_confirmation");
      expect(payload.status_code).toBeUndefined();
      expect(elicitCount.n).toBe(0);
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

// Hardening: confirm_tool_call must reference a real, un-consumed
// APPROVAL_REQUESTED — otherwise a model-driven client could approve an
// arbitrary or recycled confirm_id and bypass the gate (and write an
// APPROVAL_APPROVED that joins no request).
describe("confirm_tool_call — confirmation validation", () => {
  const probeArgs = (slug: string) => ({
    connector_slug: slug,
    method: "POST",
    path: "/orders",
    environment: "prod",
    body: { qty: 1 },
  });

  test("unknown/forged confirm_id → rejected, not executed, no APPROVAL_APPROVED", async () => {
    await suite.seedConnector({
      slug: "forged-confirm",
      environment: "prod",
      base_url: mock.baseUrl,
    });
    const client = await suite.connect();

    const approvedBaseline = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, "approval.approved")),
      );

    const res = await client.callTool({
      name: "confirm_tool_call",
      arguments: {
        tool: "probe_connector",
        arguments: probeArgs("forged-confirm"),
        confirm_id: "00000000-0000-0000-0000-000000000000",
      },
    });

    expect(res.isError).toBe(true);
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
      error_code?: string;
    };
    expect(payload.error_code).toBe("unknown_confirmation");

    const approvedAfter = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, "approval.approved")),
      );
    expect((approvedAfter[0]?.c ?? 0) - (approvedBaseline[0]?.c ?? 0)).toBe(0);
  });

  test("re-using an already-approved confirm_id → rejected (single-use)", async () => {
    await suite.seedConnector({
      slug: "reuse-confirm",
      environment: "prod",
      base_url: mock.baseUrl,
    });
    const client = await suite.connect();
    const args = probeArgs("reuse-confirm");

    // Obtain a real pending confirmation.
    const first = await client.callTool({ name: "probe_connector", arguments: args });
    const id = JSON.parse((first.content as Array<{ text: string }>)[0]!.text)
      .tool_call_id as string;
    expect(id).toBeTruthy();

    // First approval succeeds.
    const ok = await client.callTool({
      name: "confirm_tool_call",
      arguments: { tool: "probe_connector", arguments: args, confirm_id: id },
    });
    expect(ok.isError).toBeFalsy();

    // Re-using the same id is rejected — the confirmation was consumed.
    const again = await client.callTool({
      name: "confirm_tool_call",
      arguments: { tool: "probe_connector", arguments: args, confirm_id: id },
    });
    expect(again.isError).toBe(true);
    const payload = JSON.parse((again.content as Array<{ text: string }>)[0]!.text) as {
      error_code?: string;
    };
    expect(payload.error_code).toBe("confirmation_already_used");
  });
});
