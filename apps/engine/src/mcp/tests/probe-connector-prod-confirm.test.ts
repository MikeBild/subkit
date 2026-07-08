// Probe-connector prod-write confirm-loop integration test.
//
// Before the unified palette, the MCP-side gate short-circuited every
// `tenant_read` tool past `computeModeFromInput` — so `probe_connector`
// with `method: POST environment: prod` ran without confirmation on MCP,
// while chat correctly demanded it. `policyDecide` fixed this; this test
// pins the fix end-to-end.
//
// Confirmed flow:
//   1. tools/call probe_connector {method:POST, environment:prod} →
//      isError:false, content.status="needs_confirm", carries
//      tool_call_id (the trigger handle) and approval_url (the human channel).
//   2. A HUMAN grants the approval out of band (the portal). Nothing before this
//      can release the call: `sk_confirm` is a trigger, not an approval.
//   3. tools/call probe_connector {...same args..., _meta:{sk_confirm:true,
//      sk_confirm_id:<id>}} → executes, returns HTTP envelope.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { grantApproval } from "../../tools/approval.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;

beforeAll(async () => {
  process.env.SK_MCP_MODE = "authoring";
  suite = await startMcpTestSuite("probe-connector-prod-confirm");
  mock = await createMockServer((_req, res) => {
    jsonResponse(res, 201, { id: "created" });
  });
});

afterAll(async () => {
  await mock.close();
  await suite.cleanup();
  delete process.env.SK_MCP_MODE;
});

describe("probe_connector — prod-write confirm loop on MCP", () => {
  test("POST against prod first returns needs_confirm + APPROVAL_REQUESTED audit", async () => {
    await suite.seedConnector({
      slug: "prod-post-probe",
      environment: "prod",
      base_url: mock.baseUrl,
    });
    const baseline = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, "approval.requested")),
      );
    const baselineCount = baseline[0]?.c ?? 0;

    const client = await suite.connect();
    const result = await client.callTool({
      name: "probe_connector",
      arguments: {
        connector_slug: "prod-post-probe",
        method: "POST",
        path: "/orders",
        environment: "prod",
        body: { qty: 1 },
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as {
      policy_mode?: string;
      tool_call_id?: string;
    };
    expect(payload.policy_mode).toBe("confirm_before_execution");
    expect(payload.tool_call_id).toMatch(/^[0-9a-f-]{36}$/);

    // _meta.subkit.confirm carries the structured envelope for clients
    // that prefer reading meta over content. Both must agree.
    const meta = result._meta as { subkit?: { confirm?: { tool_call_id?: string } } };
    expect(meta?.subkit?.confirm?.tool_call_id).toBe(payload.tool_call_id);

    // APPROVAL_REQUESTED row was written with the confirm envelope's id.
    const after = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, "approval.requested")),
      );
    expect((after[0]?.c ?? 0) - baselineCount).toBe(1);
  });

  test("sk_confirm=true on an UNGRANTED approval does not execute", async () => {
    await suite.seedConnector({
      slug: "prod-post-probe-ungranted",
      environment: "prod",
      base_url: mock.baseUrl,
    });
    const client = await suite.connect();
    const args = {
      connector_slug: "prod-post-probe-ungranted",
      method: "POST",
      path: "/orders",
      environment: "prod",
      body: { qty: 9 },
    };

    const first = await client.callTool({ name: "probe_connector", arguments: args });
    const toolCallId = (
      JSON.parse((first.content as Array<{ text: string }>)[0]!.text) as { tool_call_id?: string }
    ).tool_call_id!;
    expect(toolCallId).toBeTruthy();

    // The model holds a real id for a real approval — and it is still not the
    // person who must approve it.
    const second = await client.callTool({
      name: "probe_connector",
      arguments: args,
      _meta: { sk_confirm: true, sk_confirm_id: toolCallId },
    });
    expect(second.isError).toBe(true);
    const payload = JSON.parse((second.content as Array<{ text: string }>)[0]!.text) as {
      error_code?: string;
      status_code?: number;
    };
    expect(payload.error_code).toBe("approval_not_granted");
    expect(payload.status_code).toBeUndefined();
  });

  test("re-issue with sk_confirm=true after a human grant proceeds; APPROVAL_APPROVED correlates by tool_call_id", async () => {
    await suite.seedConnector({
      slug: "prod-post-probe-2",
      environment: "prod",
      base_url: mock.baseUrl,
    });
    const client = await suite.connect();

    // First call — get the confirm envelope.
    const first = await client.callTool({
      name: "probe_connector",
      arguments: {
        connector_slug: "prod-post-probe-2",
        method: "POST",
        path: "/orders",
        environment: "prod",
        body: { qty: 2 },
      },
    });
    const firstPayload = JSON.parse((first.content as Array<{ text: string }>)[0]!.text) as {
      tool_call_id?: string;
    };
    const toolCallId = firstPayload.tool_call_id!;
    expect(toolCallId).toBeTruthy();

    // A person opens the approval portal and grants it. This — not the marker
    // below — is what makes the call claimable.
    const granted = await grantApproval({
      db: suite.http.db,
      approval_id: toolCallId,
      tenant_id: suite.http.tenantId,
      granted_by_user_id: suite.http.userId,
      via: "portal",
    });
    expect(granted.ok).toBe(true);

    // Approval count baseline (post-grant, pre-confirm).
    const baseline = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, "approval.approved")),
      );
    const baselineApproved = baseline[0]?.c ?? 0;

    // Re-issue with sk_confirm + sk_confirm_id. Note: the MCP SDK puts
    // _meta inside request.params, which the dispatcher reads via
    // `invocation.meta`.
    const second = await client.callTool({
      name: "probe_connector",
      arguments: {
        connector_slug: "prod-post-probe-2",
        method: "POST",
        path: "/orders",
        environment: "prod",
        body: { qty: 2 },
      },
      _meta: { sk_confirm: true, sk_confirm_id: toolCallId },
    });
    expect(second.isError).toBeFalsy();
    const secondPayload = JSON.parse((second.content as Array<{ text: string }>)[0]!.text) as {
      status_code?: number;
      body?: unknown;
      persistence?: string;
    };
    expect(secondPayload.status_code).toBe(201);
    expect(secondPayload.persistence).toBe("none");

    // APPROVAL_APPROVED row was written and correlates to the original
    // tool_call_id (the design's audit-join invariant).
    const after = await suite.http.db
      .select({
        id: auditLog.resource_id,
        action: auditLog.action,
      })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, "approval.approved")),
      );
    expect(after.length).toBe(baselineApproved + 1);
    const lastApproved = after[after.length - 1];
    expect(lastApproved?.id).toBe(toolCallId);
  });
});
