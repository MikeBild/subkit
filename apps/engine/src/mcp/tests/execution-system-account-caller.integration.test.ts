import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { generateAccessToken } from "../../auth/oauth/tokens.ts";
import { MCP_AUTHORING_SCOPE } from "../../auth/scopes.ts";
import {
  apiKeys,
  auditLog,
  executionSteps,
  executions,
  mcpOauthAccessTokens,
  mcpOauthClients,
} from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
const uuid = createDeterministicUuidFactory(0x6ca11e);

beforeAll(async () => {
  suite = await startMcpTestSuite("execution-system-account-caller");
});

afterAll(async () => {
  await suite.cleanup();
});

test("MCP workflow caller comes from the authenticated system account", async () => {
  const key = await suite.issueSystemAccountApiKey(["*"], { roleName: "admin" });
  const [apiKey] = await suite.http.db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.tenant_id, suite.http.tenantId),
        eq(apiKeys.system_account_id, key.system_account_id),
        eq(apiKeys.prefix, key.plaintext.slice(0, 12)),
      ),
    );
  if (!apiKey) throw new Error("system account API key fixture missing");
  const workflow = await suite.seedWorkflow({
    name: "MCP system account caller attribution",
    slug: "mcp-system-account-caller-attribution",
    steps: [
      {
        id: "identity",
        kind: "transform",
        language: "javascript",
        expression: "return input.scope.$caller;",
      },
    ],
  });
  const client = await suite.connectWithApiKey(key.plaintext);
  const result = await client.callTool({
    name: `wf_${workflow.slug}`,
    arguments: { $caller: { principalId: "spoofed", principalKind: "user" } },
  });
  expect(result.isError).toBeFalsy();

  const run = await waitFor(
    async () => {
      const [execution] = await suite.http.db
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, suite.http.tenantId),
            eq(executions.workflow_id, workflow.id),
          ),
        );
      return execution && !["queued", "running"].includes(execution.status) ? execution : null;
    },
    { tries: 50, sleepMs: 20, label: "MCP system account workflow caller" },
  );
  const caller = {
    tenantId: suite.http.tenantId,
    principalId: key.system_account_id,
    principalKind: "system_account" as const,
    provider: "api_key",
    productId: null,
  };
  expect(run.status).toBe("succeeded");
  expect(run.request_source).toBe("mcp");
  expect(run.caller_context).toEqual(caller);
  expect(run.authorization_context).toMatchObject({
    source: { kind: "api_key", api_key_id: apiKey.id },
  });
  const trail = await suite.http.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, suite.http.tenantId),
        eq(auditLog.resource_type, "execution"),
        eq(auditLog.resource_id, run.id),
      ),
    );
  const actions = trail.map((row) => row.action);
  expect(actions).not.toContain("execution.boundary_refused");
  expect(actions).not.toContain("execution.write_held");

  const [step] = await suite.http.db
    .select({ output: executionSteps.output_preview })
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, suite.http.tenantId),
        eq(executionSteps.execution_id, run.id),
      ),
    );
  expect(step?.output).toEqual(caller);

  const lifecycle = await waitFor(
    async () => {
      const entries = await suite.http.db
        .select({
          action: auditLog.action,
          tenant_id: auditLog.tenant_id,
          resource_type: auditLog.resource_type,
          resource_id: auditLog.resource_id,
          actor_type: auditLog.actor_type,
          actor_id: auditLog.actor_id,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, suite.http.tenantId),
            eq(auditLog.resource_type, "execution"),
            eq(auditLog.resource_id, run.id),
          ),
        );
      const matches = entries.filter(
        (entry) => entry.action === "execution.started" || entry.action === "execution.completed",
      );
      return matches.length === 2 ? matches : null;
    },
    { tries: 50, sleepMs: 20, label: "MCP system account execution lifecycle audit" },
  );
  expect(lifecycle.map((entry) => entry.action).sort()).toEqual([
    "execution.completed",
    "execution.started",
  ]);
  for (const entry of lifecycle) {
    expect(entry).toEqual({
      action: entry.action,
      tenant_id: suite.http.tenantId,
      resource_type: "execution",
      resource_id: run.id,
      actor_type: "system_account",
      actor_id: key.system_account_id,
    });
  }
  const output = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "null");
  expect(output).toEqual(caller);
});

test("persisted MCP OAuth access-token bearer caller reaches workflow output and lifecycle audit", async () => {
  const clientId = `oauth-caller-${uuid()}`;
  const scopes = ["mcp:read", MCP_AUTHORING_SCOPE];
  await suite.http.db.insert(mcpOauthClients).values({
    client_id: clientId,
    scope: scopes.join(" "),
  });
  const token = generateAccessToken();
  const [accessToken] = await suite.http.db
    .insert(mcpOauthAccessTokens)
    .values({
      tenant_id: suite.http.tenantId,
      client_id: clientId,
      user_id: suite.http.userId,
      prefix: token.prefix,
      token_sha256: token.hash,
      scope: scopes.join(" "),
      resource: `${suite.http.baseUrl}/mcp`,
      expires_at: new Date(getTestNow() + 60_000),
    })
    .returning({ id: mcpOauthAccessTokens.id });
  if (!accessToken) throw new Error("MCP OAuth access token fixture missing");

  const workflow = await suite.seedWorkflow({
    name: "MCP OAuth caller attribution",
    slug: "mcp-oauth-caller-attribution",
    steps: [
      {
        id: "identity",
        kind: "transform",
        language: "javascript",
        expression: "return input.scope.$caller;",
      },
    ],
  });
  const client = await suite.connectWithApiKey(token.plaintext);
  const result = await client.callTool({
    name: `wf_${workflow.slug}`,
    arguments: { $caller: { principalId: "spoofed", principalKind: "system_account" } },
  });
  expect(result.isError).toBeFalsy();

  const run = await waitFor(
    async () => {
      const [execution] = await suite.http.db
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, suite.http.tenantId),
            eq(executions.workflow_id, workflow.id),
          ),
        );
      return execution && !["queued", "running"].includes(execution.status) ? execution : null;
    },
    { tries: 50, sleepMs: 20, label: "MCP OAuth workflow caller" },
  );
  const caller = {
    tenantId: suite.http.tenantId,
    principalId: suite.http.userId,
    principalKind: "user" as const,
    provider: "mcp_oauth",
    productId: null,
  };
  expect(run.status).toBe("succeeded");
  expect(run.request_source).toBe("mcp");
  expect(run.caller_context).toEqual(caller);
  expect(run.authorization_context).toMatchObject({
    source: { kind: "mcp_oauth", access_token_id: accessToken.id, client_id: clientId },
  });

  const [step] = await suite.http.db
    .select({ output: executionSteps.output_preview })
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, suite.http.tenantId),
        eq(executionSteps.execution_id, run.id),
      ),
    );
  expect(step?.output).toEqual(caller);

  const lifecycle = await waitFor(
    async () => {
      const entries = await suite.http.db
        .select({
          action: auditLog.action,
          tenant_id: auditLog.tenant_id,
          resource_type: auditLog.resource_type,
          resource_id: auditLog.resource_id,
          actor_type: auditLog.actor_type,
          actor_id: auditLog.actor_id,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, suite.http.tenantId),
            eq(auditLog.resource_type, "execution"),
            eq(auditLog.resource_id, run.id),
          ),
        );
      const matches = entries.filter(
        (entry) => entry.action === "execution.started" || entry.action === "execution.completed",
      );
      return matches.length === 2 ? matches : null;
    },
    { tries: 50, sleepMs: 20, label: "MCP OAuth execution lifecycle audit" },
  );
  expect(lifecycle.map((entry) => entry.action).sort()).toEqual([
    "execution.completed",
    "execution.started",
  ]);
  for (const entry of lifecycle) {
    expect(entry).toEqual({
      action: entry.action,
      tenant_id: suite.http.tenantId,
      resource_type: "execution",
      resource_id: run.id,
      actor_type: "user",
      actor_id: suite.http.userId,
    });
  }
  const output = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "null");
  expect(output).toEqual(caller);
});
