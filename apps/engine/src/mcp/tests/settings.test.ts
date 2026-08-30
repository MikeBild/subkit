// Real transport parity for the SubKit settings MCP tools. The write travels
// through Streamable HTTP MCP, persists through the config loader, is read back
// over the public REST API, and leaves an audit row in real PostgreSQL.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/index.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("settings");
});

afterAll(async () => {
  await suite.cleanup();
});

function textBody(
  result: Awaited<ReturnType<Awaited<ReturnType<typeof suite.connect>>["callTool"]>>,
) {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("mcp settings tools", () => {
  test("admin catalog exposes an honest read tool and destructive write tool", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:admin", "settings:read", "settings:write"]);
    const client = await suite.connectWithApiKey(plaintext);
    const byName = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));

    expect(byName.get("subkit_settings")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get("subkit_update_setting")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  test("MCP hot write is immediately visible over REST and audited as MCP", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:admin", "settings:read", "settings:write"]);
    const client = await suite.connectWithApiKey(plaintext);
    const updated = await client.callTool({
      name: "subkit_update_setting",
      arguments: {
        path: "tokens.monthly_budget",
        value: 2468,
        tenant_id: suite.http.tenantId,
      },
    });
    expect(updated.isError).toBeFalsy();
    expect(textBody(updated)).toMatchObject({
      path: "tokens.monthly_budget",
      value: 2468,
      activation: "active",
      applied_immediately: true,
      requires_restart: false,
    });

    const rest = await fetch(
      `${suite.http.baseUrl}/v1/settings/tokens.monthly_budget?tenant=${suite.http.tenantId}`,
      { headers: { authorization: `Bearer ${suite.http.apiKey}` } },
    );
    expect(rest.status).toBe(200);
    expect((await rest.json()) as Record<string, unknown>).toMatchObject({
      path: "tokens.monthly_budget",
      value: 2468,
    });

    const rows = await suite.http.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, suite.http.tenantId),
          eq(auditLog.action, AuditAction.SETTINGS_CHANGED),
          eq(auditLog.resource_id, "tokens.monthly_budget"),
        ),
      )
      .orderBy(desc(auditLog.ts))
      .limit(1);
    expect(rows[0]?.metadata).toMatchObject({ request_source: "mcp" });
  });

  test("read tool reports restart semantics without changing the setting", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:admin", "settings:read"]);
    const client = await suite.connectWithApiKey(plaintext);
    const result = await client.callTool({
      name: "subkit_settings",
      arguments: { path: "server.port" },
    });
    expect(result.isError).toBeFalsy();
    const body = textBody(result) as unknown as {
      items: Array<{ path: string; meta: { requires_restart: boolean } }>;
    };
    expect(body.items).toEqual([
      expect.objectContaining({
        path: "server.port",
        meta: expect.objectContaining({ requires_restart: true }),
      }),
    ]);
  });
});
