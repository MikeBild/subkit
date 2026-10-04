import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, desc, eq } from "drizzle-orm";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import { auditLog, executions } from "../../db/schema/index.ts";
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

      const refusals = await suite.http.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "execution.boundary_refused"),
            eq(auditLog.resource_id, body.execution_id),
          ),
        );
      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.result).toBe("denied");
      expect(refusals[0]?.reason).toBe("execution_authority_unavailable");
      const metadata = refusals[0]?.metadata as Record<string, unknown>;
      expect(metadata.stage).toBe("admission");
      expect(metadata.downgraded_to_preparation).toBe(true);
      expect(metadata.request_source).toBe("mcp");
    } finally {
      await writeMock.close();
    }
  });

  test("offloads large results as a resource_link content block (not a text envelope)", async () => {
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
      expect(link.name).toContain("call-offload");
      expect(link.mimeType).toBe("application/json");
      expect(typeof link.size).toBe("number");
      expect((link.size ?? 0) > 30_000).toBe(true);

      if (link.uri.startsWith("fixture://")) {
        const read = await client.readResource({ uri: link.uri });
        expect(read.contents.length).toBe(1);
        const body = JSON.parse((read.contents[0] as { text: string }).text) as { blob: string };
        expect(body.blob.length).toBe(big.length);
      }

      const rows = await suite.http.db
        .select({ c: count() })
        .from(executions)
        .where(eq(executions.workflow_id, wf.id));
      expect(rows[0]?.c).toBeGreaterThanOrEqual(1);
    } finally {
      await bigMock.close();
    }
  });

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
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThanOrEqual(1);
    expect(content[0]?.type).toBe("text");
    expect(result.structuredContent).toBeDefined();
    expect((result.structuredContent as { result?: string })?.result).toBe("hello-structured");
  });

  test("C1: workflow WITHOUT output_schema returns no structuredContent", async () => {
    await suite.seedWorkflow({
      name: "no schema probe",
      slug: "no-schema-probe",
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
    expect(result.structuredContent).toBeUndefined();
  });

  test("C1: offloaded result (>20KB) does not carry structuredContent even with output_schema", async () => {
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
      const content = result.content as Array<Record<string, unknown>>;
      expect(content.some((c) => c.type === "resource_link")).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await bigSchemaWfMock.close();
    }
  });

  test("B3 (deviation pin): unknown tool name returns isError:true result, not a -32602 protocol error", async () => {
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
