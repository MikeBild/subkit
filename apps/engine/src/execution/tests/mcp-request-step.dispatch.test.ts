// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${item.…}` /
// `${input.…}` are workflow placeholder tokens the steps below are meant to
// carry verbatim — a template literal would resolve them in the test.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { closeDb } from "../../db/client.ts";
import { connectors, executions } from "../../db/schema/index.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
} from "../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { waitFor } from "../../test-helpers/determinism/index.ts";
import { cancel } from "../abort.ts";
import { runExecution } from "../engine.ts";
import { mcpRequestStepFixtures, SLUG } from "./mcp-request-step-fixtures.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

let connectorId: string;

let brokenConfigConnectorId: string;

const _origDatabaseUrl = process.env.DATABASE_URL;

const { fakeClient, remote, resetRemote, run, runDef } = mcpRequestStepFixtures({
  get connectorId() {
    return connectorId;
  },
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createEngineCtx("mcp-request-step");
  await closeDb();
  process.env.DATABASE_URL = ctx.testDb.url;

  const server = await seedMcpConnector(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    slug: SLUG,
    display_name: "MCP Step",
    environment: "dev",
    transport: "http",
    url: "https://alpha.mcpsteptest.example.com/mcp",
  });
  connectorId = server.id;

  await seedMcpConnector(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    slug: `${SLUG}bounded`,
    display_name: "MCP Step (own bound)",
    environment: "dev",
    transport: "http",
    url: "https://beta.mcpsteptest.example.com/mcp",
    remote_tool_call_timeout_ms: 45_000,
  });

  await seedMcpConnector(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    slug: `${SLUG}counted`,
    display_name: "MCP Step (breaker)",
    environment: "dev",
    transport: "http",
    url: "https://gamma.mcpsteptest.example.com/mcp",
  });

  const broken = await seedMcpConnector(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    slug: `${SLUG}broken`,
    display_name: "MCP Step (bad config)",
    environment: "dev",
    transport: "http",
    url: "https://delta.mcpsteptest.example.com/mcp",
  });
  brokenConfigConnectorId = broken.id;
}, 30_000);

afterEach(() => {
  resetRemote();
  __resetMcpClientPoolForTests();
});

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (_origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = _origDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

const ITEMS = 'return [{ "name": "a" }, { "name": "b" }, { "name": "c" }];';

type IterationSlot = Record<
  string,
  { data: unknown; error: { code?: string } | null; held?: true; held_request?: { body?: unknown } }
>;

function slots(output: unknown, stepId: string): Array<IterationSlot[string]> {
  return (output as IterationSlot[]).map((s) => s[stepId]!);
}

describe("an external tool call is a WRITE", () => {
  test("hold_writes materializes call_tool without dispatching it", async () => {
    const result = await run(
      "mcp-hold-call-tool",
      {
        mcp: { operation: "call_tool", tool: "search", arguments: { q: "invoices" } },
        max_retries: 0,
      },
      { hold_writes: true },
    );
    expect(result.status).toBe("succeeded");
    const step = result.steps[0]!;
    expect(step.held).toBe(true);
    expect(remote.toolCalls).toHaveLength(0);
    const held = step.held_request as { method: string; url: string | null; body: unknown };
    expect(held.method).toBe("tools/call");
    expect(held.url).toBe("https://alpha.mcpsteptest.example.com/mcp");
    expect(held.body).toEqual({ target: "search", arguments: { q: "invoices" } });
  });

  test("read_resource still executes live under hold_writes", async () => {
    const result = await run(
      "mcp-hold-read-resource",
      { mcp: { operation: "read_resource", uri: "file:///reports/q3.md" }, max_retries: 0 },
      { hold_writes: true },
    );
    expect(result.status).toBe("succeeded");
    const step = result.steps[0]!;
    expect(step.held).toBeUndefined();
    expect(remote.resourceReads).toEqual(["file:///reports/q3.md"]);
  });

  test('side_effects:"read" cannot authorize a remote tool call in a preview', async () => {
    const result = await run(
      "mcp-hold-declared-read",
      {
        mcp: { operation: "call_tool", tool: "search" },
        side_effects: "read",
        max_retries: 0,
      },
      { hold_writes: true },
    );
    expect(result.status).toBe("succeeded");
    expect(result.steps[0]?.held).toBe(true);
    expect(remote.toolCalls).toHaveLength(0);
  });
});

describe("for_each: one step, one call per item", () => {
  test("a read fans out, and the results still come back in item order", async () => {
    remote.rendezvous = 3;
    const result = await runDef("mcp-for-each-read", [
      { id: "targets", kind: "transform", language: "javascript", expression: ITEMS },
      {
        id: "fetch",
        kind: "request",
        connector_id: connectorId,
        mcp: { operation: "read_resource", uri: "file:///reports/${item.name}.md" },
        for_each: "(sourceData) => sourceData.targets.data",
        max_retries: 0,
      },
    ]);
    expect(result.status).toBe("succeeded");
    expect(remote.peakInFlight).toBe(3);
    expect([...remote.resourceReads].sort()).toEqual([
      "file:///reports/a.md",
      "file:///reports/b.md",
      "file:///reports/c.md",
    ]);
    const data = slots(result.output, "fetch").map(
      (env) => (env.data as Array<{ uri: string }>)[0]!.uri,
    );
    expect(data).toEqual(["file:///reports/a.md", "file:///reports/b.md", "file:///reports/c.md"]);
  }, 20_000);

  test("a write fan-out stays sequential", async () => {
    remote.rendezvous = 3;
    const result = await runDef("mcp-for-each-write", [
      { id: "targets", kind: "transform", language: "javascript", expression: ITEMS },
      {
        id: "push",
        kind: "request",
        connector_id: connectorId,
        mcp: { operation: "call_tool", tool: "search", arguments: { q: "${item.name}" } },
        for_each: "(sourceData) => sourceData.targets.data",
        max_retries: 0,
      },
    ]);
    expect(result.status).toBe("succeeded");
    expect(remote.peakInFlight).toBe(1);
    expect(remote.toolCalls.map((c) => c.arguments?.q)).toEqual(["a", "b", "c"]);
    expect(slots(result.output, "push")).toHaveLength(3);
  }, 30_000);

  test("a retry belongs to its own item and does not re-issue its siblings", async () => {
    remote.throwForQuery.set("b", 1);
    const result = await runDef("mcp-for-each-retry", [
      { id: "targets", kind: "transform", language: "javascript", expression: ITEMS },
      {
        id: "push",
        kind: "request",
        connector_id: connectorId,
        mcp: { operation: "call_tool", tool: "search", arguments: { q: "${item.name}" } },
        for_each: "(sourceData) => sourceData.targets.data",
        max_retries: 2,
        retry_backoff_ms: 50,
      },
    ]);
    expect(result.status).toBe("succeeded");
    expect(remote.toolCalls.map((c) => c.arguments?.q)).toEqual(["a", "b", "b", "c"]);
    const envs = slots(result.output, "push");
    expect(envs).toHaveLength(3);
    expect(envs.every((e) => e.error === null)).toBe(true);
  }, 20_000);

  test("the item the remote rejects fails the for_each, and the breaker stays shut", async () => {
    remote.isErrorForQuery.add("b");
    remote.content = [{ type: "text", text: "unknown project id" }];
    const result = await runDef("mcp-for-each-item-rejected", [
      { id: "targets", kind: "transform", language: "javascript", expression: ITEMS },
      {
        id: "push",
        kind: "request",
        connector_id: connectorId,
        mcp: { operation: "call_tool", tool: "search", arguments: { q: "${item.name}" } },
        for_each: "(sourceData) => sourceData.targets.data",
        max_retries: 2,
        retry_backoff_ms: 50,
      },
    ]);
    expect(result.status).toBe("failed");
    const step = result.steps.find((s) => s.step_key === "push")!;
    expect(step.status).toBe("failed");
    expect((step.error as { code?: string }).code).toBe("mcp_remote_error");
    expect(remote.toolCalls.map((c) => c.arguments?.q)).toEqual(["a", "b", "c"]);
    const after = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, connectorId))
    )[0]!;
    expect(after.circuit_failure_count).toBe(0);
  }, 20_000);

  test("hold_writes holds EVERY iteration with its own resolved arguments", async () => {
    const result = await runDef(
      "mcp-for-each-held",
      [
        { id: "targets", kind: "transform", language: "javascript", expression: ITEMS },
        {
          id: "push",
          kind: "request",
          connector_id: connectorId,
          mcp: { operation: "call_tool", tool: "search", arguments: { q: "${item.name}" } },
          for_each: "(sourceData) => sourceData.targets.data",
          max_retries: 0,
        },
      ],
      { hold_writes: true },
    );
    expect(result.status).toBe("succeeded");
    expect(remote.toolCalls).toHaveLength(0);
    const envs = slots(result.output, "push");
    expect(envs).toHaveLength(3);
    expect(envs.every((e) => e.held === true)).toBe(true);
    expect(
      envs.map((e) => (e.held_request?.body as { arguments?: { q?: string } })?.arguments?.q),
    ).toEqual(["a", "b", "c"]);
  }, 20_000);
});

describe("a fault in the step itself never reaches the wire", () => {
  test("an unaddressable remote tool name fails as mcp_step_invalid", async () => {
    const result = await run("mcp-bad-tool-name", {
      mcp: { operation: "call_tool", tool: "search.v2" },
      max_retries: 2,
      retry_backoff_ms: 50,
    });
    expect(result.status).toBe("failed");
    const step = result.steps[0]!;
    const error = step.error as { code?: string; message?: string };
    expect(error.code).toBe("mcp_step_invalid");
    expect(error.message).toContain("search.v2");
    expect(step.retry_count).toBe(0);
    expect(remote.toolCalls).toHaveLength(0);
    const after = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, connectorId))
    )[0]!;
    expect(after.circuit_failure_count).toBe(0);
  });

  test("a connector whose mcp config no longer parses lands in the same arm", async () => {
    await ctx.testDb.db
      .update(connectors)
      .set({ config: { mcp: { transport: "quic" } } })
      .where(eq(connectors.id, brokenConfigConnectorId));
    const result = await run("mcp-broken-config", {
      connector_id: brokenConfigConnectorId,
      mcp: { operation: "call_tool", tool: "search" },
      max_retries: 0,
    });
    expect(result.status).toBe("failed");
    const error = result.steps[0]!.error as { code?: string; message?: string };
    expect(error.code).toBe("mcp_step_invalid");
    expect(error.message).toContain("invalid mcp connector config");
    expect(remote.toolCalls).toHaveLength(0);
  });
});

describe("stopping a run stops the outbound call", () => {
  test("a cancelled call is aborted at the remote and the step says aborted", async () => {
    remote.parkUntilAborted = true;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "mcp-cancel-mid-call",
      steps: [
        {
          kind: "request",
          id: "mcp",
          connector_id: connectorId,
          mcp: { operation: "call_tool", tool: "search" },
          max_retries: 2,
          retry_backoff_ms: 50,
        },
        { kind: "transform", id: "after", language: "javascript", expression: "return 1;" },
      ],
    });
    const runPromise = runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    await waitFor(() => remote.inFlight > 0, {
      tries: 400,
      sleepMs: 5,
      label: "outbound mcp call in flight",
    });
    const row = await waitFor(
      async () =>
        (
          await ctx.testDb.db
            .select()
            .from(executions)
            .where(eq(executions.workflow_id, workflow_id))
        )[0],
      { tries: 200, sleepMs: 5, label: "execution row" },
    );
    expect(cancel(row.id)).toBe(true);

    const result = await runPromise;
    expect(result.status).toBe("aborted");
    const step = result.steps[0]!;
    expect(step.status).toBe("aborted");
    expect((step.error as { code?: string }).code).toBe("mcp_cancelled");
    expect(remote.abortedCalls).toBe(1);
    expect(remote.toolCalls).toHaveLength(1);
    expect(remote.closes).toBe(0);
    expect(result.steps.find((s) => s.step_key === "after")?.status).toBe("skipped");
    const after = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, connectorId))
    )[0]!;
    expect(after.circuit_failure_count).toBe(0);
  }, 30_000);
});
