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
  type McpClientLike,
} from "../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { waitFor } from "../../test-helpers/determinism/index.ts";
import { cancel } from "../abort.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let connectorId: string;
let boundedConnectorId: string;
let countedConnectorId: string;
let brokenConfigConnectorId: string;
const _origDatabaseUrl = process.env.DATABASE_URL;

const SLUG = "mcpstep";

const DEFAULT_CONTENT = [{ type: "text", text: "ok" }];

const remote = {
  toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> | undefined }>,
  resourceReads: [] as string[],
  promptGets: [] as Array<{ name: string; arguments: Record<string, string> | undefined }>,
  toolCallTimeouts: [] as Array<number | undefined>,
  throwTimes: 0,
  throwForQuery: new Map<string, number>(),
  isError: false,
  isErrorForQuery: new Set<string>(),
  content: DEFAULT_CONTENT as unknown,
  structured: undefined as unknown,
  hasStructured: false,
  parkUntilAborted: false,
  abortedCalls: 0,
  closes: 0,
  inFlight: 0,
  peakInFlight: 0,
  rendezvous: 0,
};

function resetRemote(): void {
  remote.toolCalls = [];
  remote.toolCallTimeouts = [];
  remote.resourceReads = [];
  remote.promptGets = [];
  remote.throwTimes = 0;
  remote.throwForQuery = new Map();
  remote.isError = false;
  remote.isErrorForQuery = new Set();
  remote.content = DEFAULT_CONTENT;
  remote.structured = undefined;
  remote.hasStructured = false;
  remote.parkUntilAborted = false;
  remote.abortedCalls = 0;
  remote.closes = 0;
  remote.inFlight = 0;
  remote.peakInFlight = 0;
  remote.rendezvous = 0;
}

function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

async function enterCall(signal: AbortSignal | undefined): Promise<void> {
  remote.inFlight += 1;
  remote.peakInFlight = Math.max(remote.peakInFlight, remote.inFlight);
  if (remote.rendezvous > 1) {
    try {
      await waitFor(() => remote.inFlight >= remote.rendezvous, {
        tries: 60,
        sleepMs: 5,
        label: "mcp fan-out rendezvous",
      });
    } catch {}
  }
  if (!remote.parkUntilAborted) return;
  if (!signal) throw new Error("no abort signal was threaded to the outbound call");
  await new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      remote.abortedCalls += 1;
      reject(abortError());
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        remote.abortedCalls += 1;
        reject(abortError());
      },
      { once: true },
    );
  });
}

const fakeClient: McpClientLike = {
  async connect() {},
  async listTools() {
    return {
      tools: [{ name: "search", description: "search", inputSchema: { type: "object" } }],
    };
  },
  async callTool(params, _resultSchema, options) {
    remote.toolCalls.push({ name: params.name, arguments: params.arguments });
    remote.toolCallTimeouts.push(options?.timeout);
    try {
      await enterCall(options?.signal);
      const q = params.arguments?.q;
      const perQuery = typeof q === "string" ? (remote.throwForQuery.get(q) ?? 0) : 0;
      if (perQuery > 0) {
        remote.throwForQuery.set(q as string, perQuery - 1);
        throw new Error("socket hang up");
      }
      if (remote.throwTimes > 0) {
        remote.throwTimes -= 1;
        throw new Error("socket hang up");
      }
      return {
        content: remote.content,
        isError: remote.isError || (typeof q === "string" && remote.isErrorForQuery.has(q)),
        ...(remote.hasStructured ? { structuredContent: remote.structured } : {}),
      };
    } finally {
      remote.inFlight -= 1;
    }
  },
  async readResource(params, _resultSchema, options) {
    remote.resourceReads.push(params.uri);
    try {
      await enterCall(options?.signal);
      return { contents: [{ uri: params.uri, text: "resource body" }] };
    } finally {
      remote.inFlight -= 1;
    }
  },
  async getPrompt(params, _resultSchema, options) {
    remote.promptGets.push({ name: params.name, arguments: params.arguments });
    try {
      await enterCall(options?.signal);
      return { messages: [{ role: "user", content: { type: "text", text: "prompt body" } }] };
    } finally {
      remote.inFlight -= 1;
    }
  },
  async close() {
    remote.closes += 1;
  },
};

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

async function run(
  name: string,
  step: Record<string, unknown>,
  options?: Record<string, unknown>,
): ReturnType<typeof runExecution> {
  return runDef(
    name,
    [{ kind: "request", id: "mcp", connector_id: connectorId, ...step }],
    options,
  );
}

async function runDef(
  name: string,
  steps: Array<Record<string, unknown>>,
  options?: Record<string, unknown>,
): ReturnType<typeof runExecution> {
  const { workflow_id } = await createWorkflowRow(ctx, { name, steps });
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: null,
    ...(options ? { options } : {}),
  });
}

const ITEMS = 'return [{ "name": "a" }, { "name": "b" }, { "name": "c" }];';

type IterationSlot = Record<
  string,
  { data: unknown; error: { code?: string } | null; held?: true; held_request?: { body?: unknown } }
>;

function slots(output: unknown, stepId: string): Array<IterationSlot[string]> {
  return (output as IterationSlot[]).map((s) => s[stepId]!);
}

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
