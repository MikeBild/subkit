// Integration test: MCP initialize returns non-empty instructions carrying
// the operator health/risk summary.
//
// When the health digest has something to report (failures or risks), the
// MCP `initialize` response MUST carry a non-empty `instructions` string
// containing the summary text. When the tenant is all-clear, the instructions
// string is the "all clear" sentence.
//
// WS4 invariants verified here:
// - Every principal (including member without stats:read) MUST receive a
//   non-empty `instructions` string containing the BASE_INTRO text.
// - A principal with stats:read additionally receives the operator health
//   digest appended on top of BASE_INTRO.
// - `serverInfo.version` MUST equal `resolveEngineVersion()` — not the
//   hardcoded "0.0.0" placeholder.

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

// Mirror the server's resolveEngineVersion() logic so tests assert the
// actual resolved value rather than a hardcoded string.
function resolveEngineVersionForTest(): string {
  if (VERSION && VERSION !== "0.0.0-dev") return VERSION;
  const env = process.env.ENGINE_VERSION;
  if (env && env !== "0.0.0-dev") return env;
  return VERSION ?? "0.0.0-dev";
}

// First sentence of BASE_INTRO — stable enough to assert on without
// coupling the test to the full multi-line string.
const BASE_INTRO_SENTINEL = "sk runs your business workflows";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function mintKey(): { plaintext: string; prefix: string; hash: string } {
  // Deterministic literal — randomBytes is banned in *.test.ts by the
  // determinism gate. One member key per file, inserted into this file's own
  // isolated test DB, so a fixed value is unique where it matters.
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
    // Ensure no metrics-driven risk signals are active.
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();

    const client = await suite.connect();
    const instructions = client.getInstructions();
    // The engine always sets instructions (either all-clear or a risk summary).
    expect(typeof instructions).toBe("string");
    expect(instructions!.length).toBeGreaterThan(0);
    // All-clear path produces the attention list's all-clear headline.
    expect(instructions).toContain("All clear — nothing needs your attention.");
  });

  test("tenant with pending failures gets a non-empty instructions string carrying the headline", async () => {
    const db = suite.http.db;
    const tenantId = suite.http.tenantId;

    // Seed a failed execution so the digest is not all-clear.
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

    // Connect a fresh client — each connection re-derives the attention list,
    // past its 10 s tenant cache (which this test clears explicitly).
    invalidateAttention();
    const client = await suite.connect();
    const instructions = client.getInstructions();
    expect(typeof instructions).toBe("string");
    expect(instructions!.length).toBeGreaterThan(0);
    // The digest headline describes the failure.
    expect(instructions).toContain("Needs attention");
  });

  test("tenant with a critical risk signal receives instructions carrying the risk summary", async () => {
    // Drive the DLQ gauge above the default threshold (5).
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();
    setDlqJobCount("execution.dlq", 10);
    invalidateAttention();

    const client = await suite.connect();
    const instructions = client.getInstructions();
    expect(typeof instructions).toBe("string");
    expect(instructions!.length).toBeGreaterThan(0);
    // The compact risk summary in instructions includes the signal headline.
    // The DLQ critical signal headline mentions "dead-letter".
    expect(instructions).toContain("dead-letter");
  });

  test("a principal without stats:read receives BASE_INTRO instructions but no operator digest", async () => {
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();

    // Insert a member-role user + key. The member role excludes stats:read
    // (see apps/engine/src/rbac/seed.ts memberPermissionFilter), so the
    // server must skip appending the health digest but MUST still send
    // the always-present BASE_INTRO (WS4: instructions is no longer gated).
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

    // Build an inline transport authenticated as the member principal.
    const transport = new StreamableHTTPClientTransport(new URL(`${suite.http.baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${memberKey.plaintext}` },
      },
    });
    const client = new Client({ name: "subkit-mcp-tests-member", version: "0.0.0" });
    await client.connect(transport as unknown as Transport);

    try {
      const instructions = client.getInstructions();

      // WS4: every principal now receives the BASE_INTRO, even without stats:read.
      expect(typeof instructions).toBe("string");
      expect(instructions!.length).toBeGreaterThan(0);
      expect(instructions).toContain(BASE_INTRO_SENTINEL);

      // The operator health digest is NOT appended when stats:read is denied.
      // The summary reads "All clear" on the all-clear path and "Needs
      // attention" otherwise. Absence of both confirms the gate held — the
      // member received BASE_INTRO only.
      expect(instructions).not.toContain("All clear");
      expect(instructions).not.toContain("Needs attention");

      // The server still exposes the full tool palette — the member can
      // author and execute workflows; only the operator digest is gated.
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

    // The resolved version must equal what resolveEngineVersion() returns.
    // In CI / local dev without a build stamp this is "0.0.0-dev"; in a
    // stamped build it is the real semver. Either way it must NOT be the
    // old hardcoded "0.0.0" placeholder that pre-WS4 always emitted.
    const expected = resolveEngineVersionForTest();
    expect(serverVersion!.version).toBe(expected);
    expect(serverVersion!.version).not.toBe("0.0.0");
  });
});
