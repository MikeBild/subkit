// Preparation does not fabricate an approval or bring back confirm_tool_call.
// A saved workflow needs its own finite local authority for live writes;
// client annotations are advisory and cannot supply that authority.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { auditLog } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;
const hits: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  suite = await startMcpTestSuite("wf-confirm-loop");
  mock = await createMockServer((req, res) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "" });
    if (req.url?.startsWith("/data")) {
      return jsonResponse(res, 200, { ok: true });
    }
    return jsonResponse(res, 200, { delivered: true });
  });
});

afterAll(async () => {
  await mock.close();
  await suite.cleanup();
});

interface ResultBody {
  status?: string;
  live_execution_authorized?: boolean;
  preview?: boolean;
  writes_held?: boolean;
  confirm_id?: string;
  approval_url?: string;
  hello?: string;
  delivered?: boolean;
}

async function approvalRequestedCountForTool(tool: string): Promise<number> {
  const rows = await suite.http.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, suite.http.tenantId),
        eq(auditLog.action, AuditAction.APPROVAL_REQUESTED),
      ),
    );
  return rows.filter((r) => (r.metadata as Record<string, unknown> | null)?.tool === tool).length;
}

describe("mcp wf_<slug> preparation without invented approvals", () => {
  test("without local authority a workflow reads, holds its write, and records no approval request", async () => {
    hits.length = 0;
    await suite.seedWorkflow({
      name: "direct write probe",
      slug: "direct-write-probe",
      steps: [
        { kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` },
        {
          kind: "request",
          id: "send",
          method: "POST",
          url: `${mock.baseUrl}/send`,
          body: { ok: true },
        },
      ],
    });
    const client = await suite.connect();

    const result = await client.callTool({ name: "wf_direct-write-probe", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0]!.text) as ResultBody;

    expect(body.status).toBe("preparation");
    expect(body.live_execution_authorized).toBe(false);
    expect(body.preview).toBeUndefined();
    expect(body.writes_held).toBeUndefined();
    expect(body.confirm_id).toBeUndefined();
    expect(body.approval_url).toBeUndefined();
    const meta = (result as { _meta?: { subkit?: { confirm?: unknown } } })._meta;
    expect(meta?.subkit?.confirm).toBeUndefined();

    expect(hits.some((h) => h.url.startsWith("/data"))).toBe(true);
    expect(hits.some((h) => h.url.startsWith("/send"))).toBe(false);

    // No approval was ever minted for this call.
    expect(await approvalRequestedCountForTool("wf_direct-write-probe")).toBe(0);
  });

  test("a read-only workflow runs directly too — unaffected either way", async () => {
    await suite.seedWorkflow({
      name: "read only probe",
      slug: "read-only-probe",
      steps: [{ kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` }],
    });
    const client = await suite.connect();

    const result = await client.callTool({ name: "wf_read-only-probe", arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0]!.text) as ResultBody;
    expect(body.preview).toBeUndefined();
    expect(body.confirm_id).toBeUndefined();
    expect(await approvalRequestedCountForTool("wf_read-only-probe")).toBe(0);
  });

  test("confirm_tool_call no longer exists as an MCP tool — calling it returns a terminal unknown-tool envelope", async () => {
    const client = await suite.connect();
    const listed = await client.listTools();
    expect(listed.tools.some((t) => t.name === "confirm_tool_call")).toBe(false);

    const result = await client.callTool({
      name: "confirm_tool_call",
      arguments: {
        tool: "wf_direct-write-probe",
        confirm_id: "11111111-1111-1111-1111-111111111111",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0]!.text) as { status?: string; error_code?: string };
    expect(body.status).toBe("cannot_help");
    expect(body.error_code).toBe("unknown_tool");
  });
});
