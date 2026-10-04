import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { VERSION } from "@cli-core/version.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  apiKeys,
  executionSteps,
  executions,
  users,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { _resetRssHighWaterForTests, setDlqJobCount } from "../../observability/instrumentation.ts";
import { resetMetricsRegistryForTests } from "../../observability/metrics.ts";
import { invalidateAttention } from "../../operator/attention.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

function resolveEngineVersionForTest(): string {
  if (VERSION && VERSION !== "0.0.0-dev") return VERSION;
  const env = process.env.ENGINE_VERSION;
  if (env && env !== "0.0.0-dev") return env;
  return VERSION ?? "0.0.0-dev";
}

const BASE_INTRO_SENTINEL = "sk runs your business workflows";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function mintKey(): { plaintext: string; prefix: string; hash: string } {
  const plaintext = "wf_live_neginit_member_0001";
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("initialize-instructions");
});

afterAll(async () => {
  resetMetricsRegistryForTests();
  _resetRssHighWaterForTests();
  await suite.cleanup();
});

describe("mcp initialize — instructions field", () => {
  test("all-clear tenant receives the all-clear instructions string", async () => {
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();

    const client = await suite.connect();
    const instructions = client.getInstructions();
    expect(typeof instructions).toBe("string");
    expect(instructions!.length).toBeGreaterThan(0);
    expect(instructions).toContain("All clear — nothing needs your attention.");
  });

  test("tenant with pending failures gets a non-empty instructions string carrying the headline", async () => {
    const db = suite.http.db;
    const tenantId = suite.http.tenantId;

    const [wf] = await db
      .insert(workflows)
      .values({
        tenant_id: tenantId,
        slug: "failing-wf-instr",
        name: "Failing Workflow",
        lifecycle: "active",
      })
      .returning();
    const [ver] = await db
      .insert(workflowVersions)
      .values({
        tenant_id: tenantId,
        workflow_id: wf!.id,
        version: 1,
        dag: { name: "Failing Workflow", steps: [] },
      })
      .returning();
    const [exec] = await db
      .insert(executions)
      .values({
        tenant_id: tenantId,
        workflow_id: wf!.id,
        workflow_version_id: ver!.id,
        source_kind: "saved",
        request_source: "scheduler",
        status: "failed",
        execution_mode: "dev",
      })
      .returning();
    await db.insert(executionSteps).values({
      tenant_id: tenantId,
      execution_id: exec!.id,
      step_key: "fetch",
      step_index: 0,
      kind: "request",
      status: "failed",
      error: { code: "http_4xx", message: "404 not found" },
    });

    invalidateAttention();
    const client = await suite.connect();
    const instructions = client.getInstructions();
    expect(typeof instructions).toBe("string");
    expect(instructions!.length).toBeGreaterThan(0);
    expect(instructions).toContain("Needs attention");
  });

  test("tenant with a critical risk signal receives instructions carrying the risk summary", async () => {
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();
    setDlqJobCount("execution.dlq", 10);
    invalidateAttention();

    const client = await suite.connect();
    const instructions = client.getInstructions();
    expect(typeof instructions).toBe("string");
    expect(instructions!.length).toBeGreaterThan(0);
    expect(instructions).toContain("dead-letter");
  });

  test("a principal without stats:read receives BASE_INTRO instructions but no operator digest", async () => {
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();

    const [memberUser] = await suite.http.db
      .insert(users)
      .values({
        tenant_id: suite.http.tenantId,
        email: "member-instr@test.local",
        role_id: await builtinRoleId(suite.http.db, "member"),
      })
      .returning();
    if (!memberUser) throw new Error("seed member user failed");

    const memberKey = mintKey();
    await suite.http.db.insert(apiKeys).values({
      tenant_id: suite.http.tenantId,
      user_id: memberUser.id,
      prefix: memberKey.prefix,
      token_sha256: memberKey.hash,
      scopes: ["*"],
    });

    const transport = new StreamableHTTPClientTransport(new URL(`${suite.http.baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${memberKey.plaintext}` },
      },
    });
    const client = new Client({ name: "subkit-mcp-tests-member", version: "0.0.0" });
    await client.connect(transport as unknown as Transport);

    try {
      const instructions = client.getInstructions();

      expect(typeof instructions).toBe("string");
      expect(instructions!.length).toBeGreaterThan(0);
      expect(instructions).toContain(BASE_INTRO_SENTINEL);

      expect(instructions).not.toContain("All clear");
      expect(instructions).not.toContain("Needs attention");

      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  test("serverInfo.version equals the resolved engine version — not the 0.0.0 placeholder", async () => {
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();

    const client = await suite.connect();

    const serverVersion = client.getServerVersion();
    expect(serverVersion).toBeDefined();
    expect(serverVersion!.name).toBe("subkit-engine");

    const expected = resolveEngineVersionForTest();
    expect(serverVersion!.version).toBe(expected);
    expect(serverVersion!.version).not.toBe("0.0.0");
  });
});
