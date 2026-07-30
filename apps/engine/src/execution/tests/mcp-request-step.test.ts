// The MCP sub-block of the request step, end to end through runExecution.
//
// The load-bearing claims:
//
//   1. A remote MCP call is a REQUEST STEP, not a step kind — so it gets
//      the request step's retry, backoff, `error_policy`,
//      `response_filters` and `for_each` for free, and its output lands in
//      the versioned execution envelope like every other driver's.
//   2. `call_tool` is classified WRITE. Under `hold_writes` it is
//      materialized and NOT dispatched — the fake client is the tripwire:
//      a single `callTool` reaching it means the write gate leaked.
//      `read_resource` is a read and must still execute live in the same
//      run, or "hold writes" would silently mean "hold everything". The
//      same classification decides `for_each` fan-out: a read fans out,
//      a write does not.
//   3. A retry is issued for a failure to REACH the server and refused for
//      a failure the server reported. Retrying the second re-sends an
//      argument the remote already rejected, and counting it toward the
//      circuit breaker would take a healthy connector offline because an
//      author passed the wrong id. A step that exhausts its retries
//      against a dead remote counts ONCE, like every other driver.
//   4. HOW LONG a remote call may run is decided inside the tenant. The
//      deadline handed to the remote is the connector's own
//      `config.mcp.remote_tool_call_timeout_ms` when it sets one and the
//      flat default otherwise — never a window a chatty remote extends by
//      emitting progress. That is the alternative to
//      `resetTimeoutOnProgress`, so the lever it points at is asserted
//      here rather than described in a comment.
//   5. The output SHAPE belongs to the operation the author wrote, not to
//      the reply the remote sent. Every `tools/call` returns
//      `{ content, structured_content }`; the two operations the protocol
//      gives no typed half return their payload verbatim.
//   6. Stopping a run stops the outbound call, and the step says
//      `aborted` — not `failed`, which would send an operator to debug a
//      remote that was fine.
//
// INJECTION PATTERN: the pool's documented TEST SEAM
// (`__setMcpPoolFactoriesForTests`) swaps SDK Client construction for an
// in-process fake. NO bun `mock.module` — module mocks are process-global
// and leak into every other test file in the same worker.
//
// One row: an external MCP server IS the connector, so the step and the
// pool address the same id and there is no second registry to keep in
// step with it.
//
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
/** A second server whose row carries its own call bound. */
let boundedConnectorId: string;
/** A third server, used only where the test moves circuit-breaker state —
 *  so the shared row's "the breaker never moved" assertions stay about
 *  what they claim. */
let countedConnectorId: string;
/** A fourth server whose `config.mcp` gets written past the schema, to
 *  reach the config half of the step-fault arm. */
let brokenConfigConnectorId: string;
const _origDatabaseUrl = process.env.DATABASE_URL;

const SLUG = "mcpstep";

const DEFAULT_CONTENT = [{ type: "text", text: "ok" }];

/** Scripted remote behaviour, reset between tests. */
const remote = {
  toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> | undefined }>,
  resourceReads: [] as string[],
  promptGets: [] as Array<{ name: string; arguments: Record<string, string> | undefined }>,
  /** The deadline each `tools/call` was issued with, in order. */
  toolCallTimeouts: [] as Array<number | undefined>,
  /** Number of leading `callTool` attempts that die at the transport. */
  throwTimes: 0,
  /** Per-argument countdown of leading transport failures, so ONE item of
   *  a `for_each` fan-out can fail its first attempt while its siblings
   *  succeed on theirs. Keyed by the `q` argument. */
  throwForQuery: new Map<string, number>(),
  /** The remote answers, and says the call itself failed. */
  isError: false,
  /** Same, but for one argument value only — so a single item of a
   *  `for_each` fan-out can be the one the remote rejects. */
  isErrorForQuery: new Set<string>(),
  content: DEFAULT_CONTENT as unknown,
  /** The typed half a tool that declares an `outputSchema` sends. Present
   *  only when `hasStructured` is set, so an absent key and an explicit
   *  `null` stay distinguishable. */
  structured: undefined as unknown,
  hasStructured: false,
  /** When set, every call parks until its own signal aborts and then
   *  raises what the SDK raises. The only way to observe that
   *  cancellation reached the OUTBOUND call rather than just unblocking
   *  the engine. */
  parkUntilAborted: false,
  /** Calls that saw their own signal fire. */
  abortedCalls: 0,
  /** `close()` calls — the pool must NOT tear a session down over a
   *  cancellation. */
  closes: 0,
  /** Concurrency observation. */
  inFlight: 0,
  peakInFlight: 0,
  /** When > 1, each in-flight call waits (bounded) for that many peers
   *  before answering. A genuinely parallel fan-out reaches the count; a
   *  sequential one never does and the wait simply expires — so
   *  `peakInFlight` separates the two without either case hanging. */
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

/** The shape the SDK's request layer raises when its signal fires. The
 *  pool classifies it `cancelled` off the name, so a plain Error here
 *  would be read as a dead socket and prove the wrong thing. */
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
    } catch {
      // Expired: the engine issued these calls one at a time. That is an
      // answer the test reads off `peakInFlight`, not a failure.
    }
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
        // The shape a dead socket produces — the pool converts it to
        // `failure: "transport"`, which is what the retry loop reads.
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

/** The three items every `for_each` block below iterates. Objects, not
 *  scalars, because `${item.name}` is the token an author actually
 *  writes. */
const ITEMS = 'return [{ "name": "a" }, { "name": "b" }, { "name": "c" }];';

/** One iteration slot of a `for_each` accumulator: `{ <step id>: envelope }`. */
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
    // Verbatim inside the envelope: the engine neither truncates nor
    // reshapes what the server sent.
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
    // The palette address, composed from the connector slug — a workflow
    // names the remote tool, the model-facing name is derived.
    expect(meta.tool_name).toBe(`mcp_${SLUG}__search`);
    expect(remote.toolCalls).toHaveLength(1);
    expect(remote.toolCalls[0]?.arguments).toEqual({ q: "invoices" });
  });

  test("arguments keep their JSON types through placeholder resolution", async () => {
    // The failure this guards: a string-coercing resolver turns
    // `${input.limit}` into "7" and the remote's own input-schema
    // validation rejects the call before it leaves the process.
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
    // A resource is addressed by URI, so there is no tool name to compose.
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
    // The filter walks the whole output, envelope included — a KEYS rule
    // an author wrote against a remote's payload keeps working whether or
    // not that payload sits under `content`.
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
      // The half the SDK validated against the tool's own `outputSchema`.
      // Merged into `content` it would lose which half carried that
      // guarantee.
      structured_content: { invoices: 3, currency: "EUR" },
    });
  });

  test("a tool that sends none gets the SAME shape with a null typed half", async () => {
    // The pin that matters: the envelope is not conditional on the reply.
    // A remote that later declares an `outputSchema` fills this key in —
    // it does not re-shape the output of a saved workflow, so
    // `${scope.mcp.content}` keeps resolving either way.
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
    // Tolerating the error is the AUTHOR's decision about the outcome, so
    // it must not also be a decision about the shape.
    expect(result.output).toEqual({
      content: [{ type: "text", text: "ok" }],
      structured_content: { partial: true },
    });
  });

  test("read_resource and get_prompt have no typed half and are not enveloped", async () => {
    // `resources/read` answers with `contents` and `prompts/get` with
    // `messages`; neither has a typed sibling in the protocol, so a
    // `structured_content` key here would promise what the wire cannot
    // deliver. The operation the author wrote picks the shape.
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
    // 1 initial + 2 retries; the third attempt is the one that landed.
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
    // Exactly one attempt: the server answered, so re-asking is pointless.
    expect(remote.toolCalls).toHaveLength(1);

    const after = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, connectorId))
    )[0]!;
    // The remote was up. Punishing the connector for the caller's argument
    // would take it offline for the whole reset window.
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
    // The breaker asks whether this connector is serving requests at all.
    // One step's retry storm is a single observation of that: counting per
    // attempt would let this one step — four attempts — trip a five-
    // failure threshold by itself, and every attempt after the first
    // reconnects to the SAME dead remote, so they are not independent
    // evidence. Same accounting as the HTTP and GraphQL paths, which
    // record from a handler reached only once the retries are spent.
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
    // 1 initial + 3 retries all reached the remote.
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
    // `step` is spread over the default connector_id, so this step
    // addresses the server that carries its own bound.
    const result = await run("mcp-connector-bound", {
      connector_id: boundedConnectorId,
      mcp: { operation: "call_tool", tool: "search" },
      max_retries: 0,
    });
    expect(result.status).toBe("succeeded");
    expect(remote.toolCallTimeouts).toEqual([45_000]);
  });

  test("a connector that sets none gets the flat default", async () => {
    // The flat bound is what makes progress-extended deadlines
    // unnecessary rather than missing: a remote that keeps emitting
    // notifications would otherwise hold the step's slot for as long as it
    // keeps talking, and the decision to allow that belongs to whoever
    // configures the connector.
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
    // The tripwire: nothing reached the remote.
    expect(remote.toolCalls).toHaveLength(0);
    const held = step.held_request as { method: string; url: string | null; body: unknown };
    expect(held.method).toBe("tools/call");
    // Not just WHAT would run — WHERE. A tool name alone does not say that.
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

  test('side_effects:"read" is the author\'s escape hatch, and it is honoured', async () => {
    // The remote's own `readOnlyHint` is not consulted — see
    // `SideEffectInput.mcp`. A claim from inside the tenant is.
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
    expect(result.steps[0]?.held).toBeUndefined();
    expect(remote.toolCalls).toHaveLength(1);
  });
});

describe("for_each: one step, one call per item", () => {
  test("a read fans out, and the results still come back in item order", async () => {
    // Fan-out class comes from the SAME classifier the write gate uses
    // (`resolveForEachConcurrency` → `classifyRequestStepSideEffects`), so
    // `resources/read` parallelises. The rendezvous makes that observable:
    // each call waits for two peers, which only ever arrive if the
    // iterations are genuinely concurrent.
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
    // Arrival order is not a claim under concurrency; the SET of resolved
    // per-item URIs is — each iteration resolved `${item.name}` against
    // its OWN item.
    expect([...remote.resourceReads].sort()).toEqual([
      "file:///reports/a.md",
      "file:///reports/b.md",
      "file:///reports/c.md",
    ]);
    // Result order IS a claim: every iteration writes its own slot, so the
    // accumulator mirrors the item order however the calls interleaved.
    const data = slots(result.output, "fetch").map(
      (env) => (env.data as Array<{ uri: string }>)[0]!.uri,
    );
    expect(data).toEqual(["file:///reports/a.md", "file:///reports/b.md", "file:///reports/c.md"]);
  }, 20_000);

  test("a write fan-out stays sequential", async () => {
    // `call_tool` is a write, so the auto bound is 1. The rendezvous is
    // armed exactly as above and expires unanswered — three writes to a
    // remote must not be issued at once just because they were authored
    // as one step.
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
    // The interaction the step kind breaks on first: retry state is
    // per-attempt inside ONE iteration. A loop counter shared across
    // iterations would either re-send `a` or spend `b`'s budget on `c`.
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
    // `b` twice, its siblings once each, and in item order.
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
    // The failing iteration IS the step's failure — a for_each that
    // finalized "succeeded" around a rejected write is the silent
    // data-loss shape this guards.
    expect(result.status).toBe("failed");
    const step = result.steps.find((s) => s.step_key === "push")!;
    expect(step.status).toBe("failed");
    expect((step.error as { code?: string }).code).toBe("mcp_remote_error");
    // Every item was still attempted, and only `b` was re-asked zero times.
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
    // Per-item materialization: a judge reading the preview must see all
    // three would-be writes, not the first one three times.
    expect(
      envs.map((e) => (e.held_request?.body as { arguments?: { q?: string } })?.arguments?.q),
    ).toEqual(["a", "b", "c"]);
  }, 20_000);
});

describe("a fault in the step itself never reaches the wire", () => {
  test("an unaddressable remote tool name fails as mcp_step_invalid", async () => {
    // `.` is legal in an MCP tool name and illegal in the composed
    // palette name several clients accept, so the driver refuses to
    // compose rather than truncate. The refusal happens before a session
    // is touched.
    const result = await run("mcp-bad-tool-name", {
      mcp: { operation: "call_tool", tool: "search.v2" },
      max_retries: 2,
      retry_backoff_ms: 50,
    });
    expect(result.status).toBe("failed");
    const step = result.steps[0]!;
    const error = step.error as { code?: string; message?: string };
    expect(error.code).toBe("mcp_step_invalid");
    // The offending half is named — "invalid tool" alone is not actionable.
    expect(error.message).toContain("search.v2");
    // Not retried, and not counted: this is the author's to fix.
    expect(step.retry_count).toBe(0);
    expect(remote.toolCalls).toHaveLength(0);
    const after = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, connectorId))
    )[0]!;
    expect(after.circuit_failure_count).toBe(0);
  });

  test("a connector whose mcp config no longer parses lands in the same arm", async () => {
    // The OTHER throw source the catch arm claims. Written past the
    // schema on purpose: a row saved by an older shape is exactly the
    // case where the step must fail with field names instead of a cast
    // error deep inside the pool.
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
    // Park first: the call must be genuinely in flight, or cancelling
    // would prove only that a queued step can be skipped.
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
    // The claim end to end: an aborted step makes an aborted RUN. Reported
    // as "failed" it would put an operator to work on a remote that was fine.
    expect(result.status).toBe("aborted");
    const step = result.steps[0]!;
    expect(step.status).toBe("aborted");
    expect((step.error as { code?: string }).code).toBe("mcp_cancelled");
    // THE proof: the fake saw its own signal fire. Without the threaded
    // signal the step would still end here, while the outbound request
    // ran out its own deadline with nobody waiting for it.
    expect(remote.abortedCalls).toBe(1);
    // Not retried — nothing is waiting for the answer.
    expect(remote.toolCalls).toHaveLength(1);
    // The pooled session is shared by the whole tenant and was never the
    // problem, so a cancellation does not tear it down.
    expect(remote.closes).toBe(0);
    expect(result.steps.find((s) => s.step_key === "after")?.status).toBe("skipped");
    const after = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, connectorId))
    )[0]!;
    // The connector did nothing wrong; the user stopped the run.
    expect(after.circuit_failure_count).toBe(0);
  }, 30_000);
});
