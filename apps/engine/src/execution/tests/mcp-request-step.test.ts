// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${item.…}` /
// `${input.…}` are workflow placeholder tokens the steps below are meant to
// carry verbatim — a template literal would resolve them in the test.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { closeDb } from "../../db/client.ts";
import { connectors } from "../../db/schema/index.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
} from "../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { runExecution } from "../engine.ts";
import { mcpRequestStepFixtures, SLUG } from "./mcp-request-step-fixtures.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

let connectorId: string;

let boundedConnectorId: string;

let countedConnectorId: string;

const _origDatabaseUrl = process.env.DATABASE_URL;

const { fakeClient, remote, resetRemote, run } = mcpRequestStepFixtures({
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

  const bounded = await seedMcpConnector(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    slug: `${SLUG}bounded`,
    display_name: "MCP Step (own bound)",
    environment: "dev",
    transport: "http",
    url: "https://beta.mcpsteptest.example.com/mcp",
    remote_tool_call_timeout_ms: 45_000,
  });
  boundedConnectorId = bounded.id;

  const counted = await seedMcpConnector(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    slug: `${SLUG}counted`,
    display_name: "MCP Step (breaker)",
    environment: "dev",
    transport: "http",
    url: "https://gamma.mcpsteptest.example.com/mcp",
  });
  countedConnectorId = counted.id;

  await seedMcpConnector(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    slug: `${SLUG}broken`,
    display_name: "MCP Step (bad config)",
    environment: "dev",
    transport: "http",
    url: "https://delta.mcpsteptest.example.com/mcp",
  });
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

describe("a successful MCP call is an ordinary request step", () => {
  test("call_tool returns the remote content in the versioned envelope", async () => {
    const result = await run("mcp-call-tool-ok", {
      mcp: { operation: "call_tool", tool: "search", arguments: { q: "invoices" } },
      max_retries: 0,
    });
    expect(result.status).toBe("succeeded");
    const step = result.steps[0]!;
    expect(step.status).toBe("succeeded");
    expect(step.retry_count).toBe(0);
    expect(result.output).toEqual({
      content: [{ type: "text", text: "ok" }],
      structured_content: null,
    });
    expect(step.output_preview).toEqual({
      content: [{ type: "text", text: "ok" }],
      structured_content: null,
    });
    const meta = step.request_meta as { driver: string; operation: string; tool_name?: string };
    expect(meta.driver).toBe("mcp");
    expect(meta.operation).toBe("tools/call");
    expect(meta.tool_name).toBe(`mcp_${SLUG}__search`);
    expect(remote.toolCalls).toHaveLength(1);
    expect(remote.toolCalls[0]?.arguments).toEqual({ q: "invoices" });
  });

  test("arguments keep their JSON types through placeholder resolution", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "mcp-typed-args",
      steps: [
        {
          kind: "request",
          id: "mcp",
          connector_id: connectorId,
          mcp: {
            operation: "call_tool",
            tool: "search",
            arguments: { limit: "${input.limit}", q: "x" },
          },
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: { limit: 7 },
    });
    expect(result.status).toBe("succeeded");
    expect(remote.toolCalls[0]?.arguments).toEqual({ limit: 7, q: "x" });
  });

  test("read_resource and get_prompt reach their own MCP methods", async () => {
    const read = await run("mcp-read-resource", {
      mcp: { operation: "read_resource", uri: "file:///reports/q3.md" },
      max_retries: 0,
    });
    expect(read.status).toBe("succeeded");
    expect(read.output).toEqual([{ uri: "file:///reports/q3.md", text: "resource body" }]);
    const readMeta = read.steps[0]!.request_meta as { operation: string; tool_name?: string };
    expect(readMeta.operation).toBe("resources/read");
    expect(remote.resourceReads).toEqual(["file:///reports/q3.md"]);
    expect(readMeta.tool_name).toBeUndefined();

    const prompt = await run("mcp-get-prompt", {
      mcp: { operation: "get_prompt", prompt: "summarise", arguments: { tone: "terse" } },
      max_retries: 0,
    });
    expect(prompt.status).toBe("succeeded");
    expect((prompt.steps[0]!.request_meta as { operation: string }).operation).toBe("prompts/get");
    expect(remote.promptGets[0]?.arguments).toEqual({ tone: "terse" });
  });

  test("response_filters run on the step output, as on every other driver", async () => {
    remote.content = { secret: "shhh", keep: "yes" };
    const result = await run("mcp-response-filter", {
      mcp: { operation: "call_tool", tool: "search" },
      response_filters: [{ target: "KEYS", action: "REMOVE", pattern: "^secret$" }],
      max_retries: 0,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ content: { keep: "yes" }, structured_content: null });
  });
});

describe("the output shape belongs to the operation, not to the reply", () => {
  test("a tool that sends a typed half gets it beside the content, not merged", async () => {
    remote.hasStructured = true;
    remote.structured = { invoices: 3, currency: "EUR" };
    const result = await run("mcp-structured", {
      mcp: { operation: "call_tool", tool: "search" },
      max_retries: 0,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({
      content: [{ type: "text", text: "ok" }],
      structured_content: { invoices: 3, currency: "EUR" },
    });
  });

  test("a tool that sends none gets the SAME shape with a null typed half", async () => {
    const result = await run("mcp-unstructured", {
      mcp: { operation: "call_tool", tool: "search" },
      max_retries: 0,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({
      content: [{ type: "text", text: "ok" }],
      structured_content: null,
    });
  });

  test("accepting a remote error under error_policy does not change the shape", async () => {
    remote.isError = true;
    remote.hasStructured = true;
    remote.structured = { partial: true };
    const result = await run("mcp-structured-tolerated", {
      mcp: { operation: "call_tool", tool: "search" },
      error_policy: "all",
      max_retries: 0,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({
      content: [{ type: "text", text: "ok" }],
      structured_content: { partial: true },
    });
  });

  test("read_resource and get_prompt have no typed half and are not enveloped", async () => {
    const read = await run("mcp-shape-read-resource", {
      mcp: { operation: "read_resource", uri: "file:///reports/q3.md" },
      max_retries: 0,
    });
    expect(read.output).toEqual([{ uri: "file:///reports/q3.md", text: "resource body" }]);

    const prompt = await run("mcp-shape-get-prompt", {
      mcp: { operation: "get_prompt", prompt: "summarise" },
      max_retries: 0,
    });
    expect(prompt.output).toEqual([
      { role: "user", content: { type: "text", text: "prompt body" } },
    ]);
  });
});

describe("retry is for reaching the server, not for what it said", () => {
  test("a transport failure is retried and the step then succeeds", async () => {
    remote.throwTimes = 2;
    const result = await run("mcp-retry-transport", {
      mcp: { operation: "call_tool", tool: "search" },
      max_retries: 3,
      retry_backoff_ms: 50,
    });
    expect(result.status).toBe("succeeded");
    const step = result.steps[0]!;
    expect(step.retry_count).toBe(2);
    expect(remote.toolCalls).toHaveLength(3);
  });

  test("a remote error is NOT retried and does NOT open the circuit breaker", async () => {
    remote.isError = true;
    remote.content = [{ type: "text", text: "unknown project id" }];
    const before = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, connectorId))
    )[0]!;
    expect(before.circuit_failure_count).toBe(0);

    const result = await run("mcp-remote-error", {
      mcp: { operation: "call_tool", tool: "search" },
      max_retries: 3,
      retry_backoff_ms: 50,
    });
    expect(result.status).toBe("failed");
    const step = result.steps[0]!;
    expect((step.error as { code?: string }).code).toBe("mcp_remote_error");
    expect(step.retry_count).toBe(0);
    expect(remote.toolCalls).toHaveLength(1);

    const after = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, connectorId))
    )[0]!;
    expect(after.circuit_failure_count).toBe(0);
    expect(after.circuit_state).toBe("closed");
  });

  test('error_policy "all" accepts what the remote reported instead of failing', async () => {
    remote.isError = true;
    remote.content = [{ type: "text", text: "partial: 2 of 3 pages" }];
    const result = await run("mcp-error-policy-all", {
      mcp: { operation: "call_tool", tool: "search" },
      error_policy: "all",
      max_retries: 0,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({
      content: [{ type: "text", text: "partial: 2 of 3 pages" }],
      structured_content: null,
    });
    expect(result.warnings?.map((w) => w.code)).toContain("mcp_remote_error");
  });

  test("a step that exhausts its retries against a dead remote counts ONCE", async () => {
    const before = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, countedConnectorId))
    )[0]!;
    remote.throwTimes = 99;
    const result = await run("mcp-breaker-per-step", {
      connector_id: countedConnectorId,
      mcp: { operation: "call_tool", tool: "search" },
      max_retries: 3,
      retry_backoff_ms: 50,
    });
    expect(result.status).toBe("failed");
    const step = result.steps[0]!;
    expect((step.error as { code?: string }).code).toBe("mcp_unavailable");
    expect(step.retry_count).toBe(3);
    expect(remote.toolCalls).toHaveLength(4);

    const after = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, countedConnectorId))
    )[0]!;
    expect(after.circuit_failure_count).toBe(before.circuit_failure_count + 1);
  });
});

describe("how long a remote call may run is decided inside the tenant", () => {
  test("the connector's own bound is the deadline the remote is actually given", async () => {
    const result = await run("mcp-connector-bound", {
      connector_id: boundedConnectorId,
      mcp: { operation: "call_tool", tool: "search" },
      max_retries: 0,
    });
    expect(result.status).toBe("succeeded");
    expect(remote.toolCallTimeouts).toEqual([45_000]);
  });

  test("a connector that sets none gets the flat default", async () => {
    const result = await run("mcp-default-bound", {
      mcp: { operation: "call_tool", tool: "search" },
      max_retries: 0,
    });
    expect(result.status).toBe("succeeded");
    expect(remote.toolCallTimeouts).toEqual([30_000]);
  });
});
