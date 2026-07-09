// `probe_connector` prod-write over MCP now proceeds directly.
//
// Before this change, `policyDecide` gated a `confirm_before_execution`
// decision (here: `probe_connector` POST against a `prod` connector) with a
// server-side `needs_confirm` envelope on every surface. MCP writes now
// execute directly instead: the client's native `destructiveHint` dialog is
// the human gate (it blocks BEFORE the call reaches the engine), and
// `probe_connector` advertises `destructiveHint:true` in `tools/list`
// (mcp/capabilities/tool-meta.ts, pinned by tools-list.test.ts) so a trusted
// client always renders that dialog for this tool. `policyDecide` therefore
// collapses `confirm_before_execution` to `proceed` for `surface:"mcp"`
// (tools/policy.ts) — no `needs_confirm`, no minted approval, no
// APPROVAL_REQUESTED audit row.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
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

describe("probe_connector — prod write over MCP proceeds directly", () => {
  test("POST against prod dispatches immediately — no needs_confirm, no APPROVAL_REQUESTED audit row", async () => {
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
      status?: string;
      status_code?: number;
      policy_mode?: string;
      tool_call_id?: string;
    };
    // The call actually executed against the mock upstream.
    expect(payload.status_code).toBe(201);
    expect(payload.status).toBeUndefined();
    expect(payload.policy_mode).toBeUndefined();
    expect(payload.tool_call_id).toBeUndefined();

    // No confirm envelope in _meta either.
    const meta = result._meta as { subkit?: { confirm?: unknown } } | undefined;
    expect(meta?.subkit?.confirm).toBeUndefined();

    // No APPROVAL_REQUESTED row was minted for this call.
    const after = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, "approval.requested")),
      );
    expect((after[0]?.c ?? 0) - baselineCount).toBe(0);
  });

  // The dispatcher's confirm-marker replay step (step 3) is generic and
  // surface-agnostic: whenever `_meta.sk_confirm` is present it tries to
  // CLAIM the named approval, unconditionally. Since MCP never mints one
  // through the policy gate anymore, a marker naming an id nothing ever
  // requested claims nothing — it fails honestly rather than silently
  // proceeding on a made-up handle.
  test("a stray _meta.sk_confirm marker naming an unknown id is rejected, not silently accepted", async () => {
    await suite.seedConnector({
      slug: "prod-post-probe-marker",
      environment: "prod",
      base_url: mock.baseUrl,
    });
    const client = await suite.connect();
    const args = {
      connector_slug: "prod-post-probe-marker",
      method: "POST" as const,
      path: "/orders",
      environment: "prod" as const,
      body: { qty: 9 },
    };

    // No marker at all: the call just executes.
    const plain = await client.callTool({ name: "probe_connector", arguments: args });
    const plainBody = JSON.parse((plain.content as Array<{ text: string }>)[0]!.text) as {
      status_code?: number;
    };
    expect(plainBody.status_code).toBe(201);

    // A marker naming an id nobody ever requested claims nothing.
    const withStrayMarker = await client.callTool({
      name: "probe_connector",
      arguments: args,
      _meta: { sk_confirm: true, sk_confirm_id: "11111111-1111-1111-1111-111111111111" },
    });
    expect(withStrayMarker.isError).toBe(true);
    const strayBody = JSON.parse((withStrayMarker.content as Array<{ text: string }>)[0]!.text) as {
      error_code?: string;
    };
    expect(strayBody.error_code).toBe("unknown_confirmation");
  });
});
