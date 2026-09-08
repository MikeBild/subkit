import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { count, desc, eq } from "drizzle-orm";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import { executions } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { MemoryObjectStore, setObjectStoreForTesting } from "../../storage/object-store.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;
let originalObjectStoreBucket: string;

beforeAll(async () => {
  suite = await startMcpTestSuite("tools-call");
  originalObjectStoreBucket = getConfig().storage.object_store.bucket;
  await setConfigKey("storage.object_store.bucket", "test", { force: true });
  setObjectStoreForTesting(new MemoryObjectStore());
  mock = await createMockServer((_req, res) => {
    jsonResponse(res, 200, { hello: "world" });
  });
});

afterAll(async () => {
  await mock.close();
  setObjectStoreForTesting(null);
  await setConfigKey("storage.object_store.bucket", originalObjectStoreBucket, { force: true });
  await suite.cleanup();
});

describe("mcp tools/call", () => {
  test("runs the workflow and returns the result", async () => {
    const wf = await suite.seedWorkflow({
      name: "call probe",
      slug: "call-probe",
      steps: [
        {
          kind: "request",
          id: "u",
          method: "GET",
          url: `${mock.baseUrl}/ping`,
        },
      ],
    });
    const client = await suite.connect();
    const result = await client.callTool({
      name: "wf_call-probe",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBe(1);
    const parsed = JSON.parse(content[0]!.text) as { hello: string };
    expect(parsed.hello).toBe("world");

    // An executions row should have been materialized for the tenant.
    const rows = await suite.http.db
      .select({ c: count() })
      .from(executions)
      .where(eq(executions.workflow_id, wf.id));
    expect(rows[0]?.c).toBeGreaterThanOrEqual(1);
  });

  test("emits progress notifications when the caller requests progress", async () => {
    await suite.seedWorkflow({
      name: "call progress",
      slug: "call-progress",
      steps: [
        {
          kind: "request",
          id: "u",
          method: "GET",
          url: `${mock.baseUrl}/ping`,
        },
      ],
    });
    const client = await suite.connect();
    const progress: Array<{
      progress: number;
      total?: number | undefined;
      message?: string | undefined;
    }> = [];

    const result = await client.callTool({ name: "wf_call-progress", arguments: {} }, undefined, {
      onprogress: (item) => {
        progress.push(item);
      },
    });

    expect(result.isError).toBeFalsy();
    expect(
      progress.some(
        (item) => item.progress === 1 && item.total === 1 && item.message === "completed",
      ),
    ).toBe(true);
  });

  test("client cancellation aborts an in-flight workflow call", async () => {
    const slowMock = await createMockServer(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 3_000)); // allow-wall-clock: request stays open until MCP cancellation arrives
      jsonResponse(res, 200, { ok: true });
    });
    try {
      const wf = await suite.seedWorkflow({
        name: "call cancel",
        slug: "call-cancel",
        steps: [
          {
            kind: "request",
            id: "slow",
            method: "GET",
            url: `${slowMock.baseUrl}/slow`,
            timeout_ms: 30_000,
            max_retries: 0,
          },
        ],
      });
      const client = await suite.connect();
      const ac = new AbortController();
      const call = client.callTool({ name: "wf_call-cancel", arguments: {} }, undefined, {
        signal: ac.signal,
        timeout: 10_000,
      });

      await waitFor(
        async () => {
          const rows = await suite.http.db
            .select({ id: executions.id })
            .from(executions)
            .where(eq(executions.workflow_id, wf.id))
            .limit(1);
          return rows[0]?.id ?? false;
        },
        { tries: 30, sleepMs: 100, label: "mcp workflow execution materialized" },
      );

      ac.abort("test_cancelled");
      await expect(call).rejects.toThrow(/test_cancelled/);

      const status = await waitFor(
        async () => {
          const rows = await suite.http.db
            .select({ status: executions.status })
            .from(executions)
            .where(eq(executions.workflow_id, wf.id))
            .orderBy(desc(executions.created_at))
            .limit(1);
          return rows[0]?.status === "aborted" ? rows[0].status : false;
        },
        { tries: 30, sleepMs: 100, label: "mcp workflow execution aborted" },
      );
      expect(status).toBe("aborted");
    } finally {
      await slowMock.close();
    }
  }, 10_000);

  // A client annotation is not server-verifiable execution authority.
  test("a wf_* run without authority reads but holds writes and reports preparation", async () => {
    const hits: string[] = [];
    const writeMock = await createMockServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url?.startsWith("/data")) return jsonResponse(res, 200, { ok: true });
      return jsonResponse(res, 200, { delivered: true });
    });
    try {
      const wf = await suite.seedWorkflow({
        name: "call direct write",
        slug: "call-direct-write",
        steps: [
          { kind: "request", id: "fetch", method: "GET", url: `${writeMock.baseUrl}/data` },
          {
            kind: "request",
            id: "send",
            method: "POST",
            url: `${writeMock.baseUrl}/send`,
            body: { ok: true },
          },
        ],
      });
      const client = await suite.connect();
      const result = await client.callTool({ name: "wf_call-direct-write", arguments: {} });
      expect(result.isError).toBe(true);

      const content = result.content as Array<{ type: string; text: string }>;
      const body = JSON.parse(content[0]!.text) as {
        status: string;
        execution_id: string;
        live_execution_authorized: boolean;
        warnings: Array<{ code: string }>;
        confirm_id?: string;
        approval_url?: string | null;
      };
      expect(body.status).toBe("preparation");
      expect(body.execution_id).toBeTruthy();
      expect(body.live_execution_authorized).toBe(false);
      expect(body.warnings.some((warning) => warning.code === "held_preview_no_writes")).toBe(true);
      expect(body.confirm_id).toBeUndefined();
      expect(body.approval_url).toBeUndefined();

      const meta = (result as { _meta?: { subkit?: { confirm?: unknown } } })._meta;
      expect(meta?.subkit?.confirm).toBeUndefined();

      expect(hits.some((u) => u.startsWith("/data"))).toBe(true);
      expect(hits.some((u) => u.startsWith("/send"))).toBe(false);

      const rows = await suite.http.db
        .select({ c: count() })
        .from(executions)
        .where(eq(executions.workflow_id, wf.id));
      expect(rows[0]?.c).toBeGreaterThanOrEqual(1);
    } finally {
      await writeMock.close();
    }
  });

  // Affordance regression guard: when a workflow tool result exceeds
  // MCP_OFFLOAD_CHAR_CAP (20 KB), the engine MUST return a native
  // `resource_link` content block so MCP clients can auto-fetch the
  // body via `resources/read`. The previous text-encoded JSON envelope
  // forced LLM agents to parse a URI out of a string field, which they
  // rarely did — an agent would get an offloaded large page back as an
  // unreachable pointer until this contract was fixed.
  test("offloads large results as a resource_link content block (not a text envelope)", async () => {
    // Build a payload that will reliably exceed MCP_OFFLOAD_CHAR_CAP (20 KB).
    const big = "x".repeat(30_000);
    const bigMock = await createMockServer((_req, res) => {
      jsonResponse(res, 200, { blob: big });
    });
    try {
      const wf = await suite.seedWorkflow({
        name: "call offload",
        slug: "call-offload",
        steps: [
          {
            kind: "request",
            id: "u",
            method: "GET",
            url: `${bigMock.baseUrl}/big`,
          },
        ],
      });
      const client = await suite.connect();
      const result = await client.callTool({
        name: "wf_call-offload",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<Record<string, unknown>>;

      // Exactly two blocks: a brief text summary, then the resource_link.
      expect(content.length).toBe(2);
      const textBlock = content[0] as { type: string; text: string };
      expect(textBlock.type).toBe("text");
      expect(textBlock.text).toMatch(/offloaded/i);

      const link = content[1] as {
        type: string;
        uri: string;
        name: string;
        mimeType?: string;
        size?: number;
        description?: string;
      };
      expect(link.type).toBe("resource_link");
      expect(link.uri).toMatch(/^(fixture|s3):\/\//);
      expect(link.name).toContain("call-offload"); // wf_call-offload
      expect(link.mimeType).toBe("application/json");
      expect(typeof link.size).toBe("number");
      expect((link.size ?? 0) > 30_000).toBe(true);

      // Round-trip: read the resource and confirm the body is intact.
      if (link.uri.startsWith("fixture://")) {
        const read = await client.readResource({ uri: link.uri });
        expect(read.contents.length).toBe(1);
        const body = JSON.parse((read.contents[0] as { text: string }).text) as { blob: string };
        expect(body.blob.length).toBe(big.length);
      }

      // Executions row was materialized.
      const rows = await suite.http.db
        .select({ c: count() })
        .from(executions)
        .where(eq(executions.workflow_id, wf.id));
      expect(rows[0]?.c).toBeGreaterThanOrEqual(1);
    } finally {
      await bigMock.close();
    }
  });

  // C1 — MCP 2025-11-25 tools §Output Schema: when a workflow declares an
  // `output_schema` AND the run is a clean (non-preview) success with an
  // object output, tools/call MUST return `structuredContent` mirroring
  // the output. The text content block is always present (back-compat SHOULD).
  test("C1: workflow with output_schema returns structuredContent on clean success", async () => {
    await suite.seedWorkflow({
      name: "structured output probe",
      slug: "structured-output-probe",
      output_schema: {
        type: "object",
        properties: { result: { type: "string" } },
      },
      steps: [
        {
          kind: "transform",
          id: "shape",
          // Transform-only workflow: no write steps → hold_writes produces no
          // held steps → isHeldPreview = false → structuredContent is emitted.
          expression: "return { result: 'hello-structured' };",
          language: "javascript",
        },
      ],
    });
    const client = await suite.connect();
    const result = await client.callTool({
      name: "wf_structured-output-probe",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    // Text block is always present for back-compat.
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThanOrEqual(1);
    expect(content[0]?.type).toBe("text");
    // structuredContent mirrors the workflow output object.
    expect(result.structuredContent).toBeDefined();
    expect((result.structuredContent as { result?: string })?.result).toBe("hello-structured");
  });

  test("C1: workflow WITHOUT output_schema returns no structuredContent", async () => {
    await suite.seedWorkflow({
      name: "no schema probe",
      slug: "no-schema-probe",
      // No output_schema declared → structuredContent must be absent.
      steps: [
        {
          kind: "transform",
          id: "shape",
          expression: "return { data: 'plain' };",
          language: "javascript",
        },
      ],
    });
    const client = await suite.connect();
    const result = await client.callTool({ name: "wf_no-schema-probe", arguments: {} });
    expect(result.isError).toBeFalsy();
    // No output_schema → no structuredContent at all.
    expect(result.structuredContent).toBeUndefined();
  });

  test("C1: offloaded result (>20KB) does not carry structuredContent even with output_schema", async () => {
    // The offload path returns a resource_link; it intentionally omits
    // structuredContent to avoid inlining a multi-KB object. This guards the
    // off-ramp so the engine never emits both a resource_link AND structuredContent.
    const big = "x".repeat(30_000);
    const bigSchemaWfMock = await createMockServer((_req, res) => {
      jsonResponse(res, 200, { blob: big });
    });
    try {
      await suite.seedWorkflow({
        name: "call schema offload",
        slug: "call-schema-offload",
        output_schema: {
          type: "object",
          properties: { blob: { type: "string" } },
        },
        steps: [
          {
            kind: "request",
            id: "fetch",
            method: "GET",
            url: `${bigSchemaWfMock.baseUrl}/big`,
          },
        ],
      });
      const client = await suite.connect();
      const result = await client.callTool({ name: "wf_call-schema-offload", arguments: {} });
      expect(result.isError).toBeFalsy();
      // Offloaded path: resource_link present, structuredContent absent.
      const content = result.content as Array<Record<string, unknown>>;
      expect(content.some((c) => c.type === "resource_link")).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await bigSchemaWfMock.close();
    }
  });

  // B3 — Deliberate protocol deviation: subkit returns isError:true RESULTS
  // (not -32602 protocol errors) for unknown tools. This lets the LLM agent
  // observe the error text and self-correct without aborting the tool-call
  // chain. Consistent with the -32000 init-params decision in
  // streamable-http-jsonrpc.test.ts; both are intentional deviations from
  // the spec recommendation.
  test("B3 (deviation pin): unknown tool name returns isError:true result, not a -32602 protocol error", async () => {
    // A -32602 would throw in the SDK client; isError:true does NOT throw.
    // That means the model receives the error as content and can self-correct.
    const client = await suite.connect();
    const result = await client.callTool({
      name: "totally_unknown_xyzzy_tool",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  test("B3 (deviation pin): wf_<unknownslug> returns a terminal, actionable workflow_not_found envelope", async () => {
    const client = await suite.connect();
    const result = await client.callTool({
      name: "wf_does-not-exist-anywhere",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    // W4.5 anti-spiral: the dead-end is a structured, terminal envelope
    // naming the recovery path — not a bare "workflow not found" string a
    // client can loop on.
    const content = result.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0]!.text) as {
      status: string;
      error_code: string;
      next_best_actions: string[];
    };
    expect(body.status).toBe("cannot_help");
    expect(body.error_code).toBe("workflow_not_found");
    expect(body.next_best_actions).toContain("find_workflow");
  });

  test("maps structured workflow parameters through the workflow tool surface", async () => {
    await suite.seedWorkflow({
      name: "call input probe",
      slug: "call-input-probe",
      input_schema: {
        type: "object",
        required: ["date"],
        properties: {
          date: { type: "string" },
        },
      },
      steps: [
        {
          kind: "transform",
          id: "shape",
          expression: "return input.input.date;",
          language: "javascript",
        },
      ],
    });
    const client = await suite.connect();
    const result = await client.callTool({
      name: "wf_call-input-probe",
      arguments: {
        date: "tomorrow +1",
      },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBe(1);
    expect(JSON.parse(content[0]!.text)).toBe("tomorrow +1");
  });
});
