import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, desc, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/index.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { createSecondaryTenant, type SecondaryTenant } from "../../http/tests/setup.ts";
import { grantApproval } from "../../tools/approval.ts";
import { handleSubkitUpdateSetting } from "../tools/settings.ts";
import { replayHumanGrantedMcpCall } from "./approved-call-fixture.ts";
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

  test("a human-approved MCP hot write is visible over REST and audited as MCP", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:admin", "settings:read", "settings:write"]);
    const client = await suite.connectWithApiKey(plaintext);
    const pending = await client.callTool({
      name: "subkit_update_setting",
      arguments: {
        path: "tokens.monthly_budget",
        value: 2468,
        tenant_id: suite.http.tenantId,
      },
    });
    expect(textBody(pending).status).toBe("needs_confirm");
    const updated = await replayHumanGrantedMcpCall(suite, client, pending);
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

  test("MCP and REST share the hot OIDC provider setting", async () => {
    const { plaintext } = await suite.issueApiKey([
      "mcp:admin",
      "settings:read",
      "settings:write",
      "settings:read:global",
      "settings:write:global",
    ]);
    const client = await suite.connectWithApiKey(plaintext);
    const providers = [
      { protocol: "api_key", id: "api-key", label: "SubKit API key" },
      {
        protocol: "oidc",
        id: "workforce",
        label: "Workforce SSO",
        issuer_url: "https://identity.example.test",
        client_id: "subkit-test-client",
        scopes: "openid profile email",
        tenant_slug: "default",
      },
    ];
    const pending = await client.callTool({
      name: "subkit_update_setting",
      arguments: { path: "auth.providers", value: providers },
    });
    expect(textBody(pending).status).toBe("needs_confirm");
    const updated = await replayHumanGrantedMcpCall(suite, client, pending);
    expect(updated.isError).toBeFalsy();
    expect(textBody(updated)).toMatchObject({
      path: "auth.providers",
      value: providers,
      activation: "active",
      applied_immediately: true,
      requires_restart: false,
      pending_restart_keys: [],
    });

    const rest = await fetch(`${suite.http.baseUrl}/v1/settings/auth.providers`, {
      headers: { authorization: `Bearer ${suite.http.apiKey}` },
    });
    expect(rest.status).toBe(200);
    expect((await rest.json()) as Record<string, unknown>).toMatchObject({
      path: "auth.providers",
      value: providers,
      meta: { kind: "json", sensitive: false, requiresRestart: false },
    });
  });

  test("read tool reports restart semantics without changing the setting", async () => {
    const { plaintext } = await suite.issueApiKey([
      "mcp:admin",
      "settings:read",
      "settings:read:global",
    ]);
    const client = await suite.connectWithApiKey(plaintext);
    const result = await client.callTool({
      name: "subkit_settings",
      arguments: { path: "server.port" },
    });
    expect(result.isError).toBeFalsy();
    const body = textBody(result) as unknown as {
      items: Array<{ path: string; meta: { requiresRestart: boolean } }>;
    };
    expect(body.items).toEqual([
      expect.objectContaining({
        path: "server.port",
        meta: expect.objectContaining({ requiresRestart: true }),
      }),
    ]);
  });

  test("read tool reports the same default and enum members as REST", async () => {
    const { plaintext } = await suite.issueApiKey([
      "mcp:admin",
      "settings:read",
      "settings:read:global",
    ]);
    const client = await suite.connectWithApiKey(plaintext);
    const result = await client.callTool({
      name: "subkit_settings",
      arguments: { path: "log.level" },
    });
    expect(result.isError).toBeFalsy();
    const mcpMeta = (textBody(result) as unknown as { items: Array<{ meta: object }> }).items[0]
      ?.meta;
    const rest = await fetch(`${suite.http.baseUrl}/v1/settings/log.level`, {
      headers: { authorization: `Bearer ${suite.http.apiKey}` },
    });
    const restMeta = ((await rest.json()) as { meta: object }).meta;
    const expected = {
      default: "info",
      enum_values: ["trace", "debug", "info", "warn", "error", "fatal"],
    };
    expect(mcpMeta).toMatchObject(expected);
    expect(restMeta).toMatchObject(expected);
  });
});

describe("mcp settings tools outside the operator workspace", () => {
  let secondary: SecondaryTenant;

  beforeAll(async () => {
    secondary = await createSecondaryTenant(suite.http, "mcp-settings");
  });

  async function grantedCall(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const pending = textBody(await client.callTool({ name, arguments: args }));
    expect(pending.status).toBe("needs_confirm");
    const granted = await grantApproval({
      db: suite.http.db,
      tenant_id: secondary.tenantId,
      approval_id: pending.tool_call_id as string,
      granted_by_user_id: secondary.admin.userId,
      via: "portal",
    });
    if (!granted.ok) throw new Error(`grant failed: ${granted.code}`);
    return textBody(
      await client.callTool({
        name: "confirm_tool_call",
        arguments: { tool: name, confirm_id: pending.tool_call_id },
      }),
    );
  }

  test("an admin over API key and MCP OAuth cannot change or read the engine", async () => {
    const adminModeKey = await suite.issueApiKeyForTenant(
      secondary.tenantId,
      secondary.admin.userId,
      ["mcp:admin"],
    );
    for (const token of [adminModeKey.plaintext, secondary.admin.oauthToken]) {
      const client = await suite.connectWithApiKey(token);

      const own = textBody(await client.callTool({ name: "subkit_settings", arguments: {} }));
      expect(own.view).toBe("tenant");
      expect(JSON.stringify(own)).not.toContain(suite.http.tenantId);

      const foreign = textBody(
        await client.callTool({
          name: "subkit_settings",
          arguments: { tenant_id: suite.http.tenantId },
        }),
      );
      expect(foreign.error_code).toBe("scope_violation");

      const global = await grantedCall(client, "subkit_update_setting", {
        path: "log.level",
        value: "debug",
      });
      expect(global.error_code).toBe("operator_required");

      const otherTenant = await grantedCall(client, "subkit_update_setting", {
        path: "llm.model",
        value: "cross-tenant",
        tenant_id: suite.http.tenantId,
      });
      expect(otherTenant.error_code).toBe("scope_violation");
    }
  });

  test("a member never sees the write tool and the handler refuses engine-wide writes", async () => {
    const client = await suite.connectWithApiKey(secondary.member.apiKey);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("subkit_update_setting");
    const result = await handleSubkitUpdateSetting(
      {
        db: suite.http.db,
        principal: {
          provider: "api_key",
          kind: "user",
          id: secondary.member.userId,
          tenant_id: secondary.tenantId,
          roles: ["member"],
          scopes: ["*"],
        },
      },
      { path: "llm.model", value: "member-global" },
    );
    expect(result).toMatchObject({ ok: false, data: { error_code: "operator_required" } });
  });
});
