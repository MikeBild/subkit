import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildToolAnnotations } from "../capabilities/tool-meta.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("tools-list");
});

afterAll(async () => {
  await suite.cleanup();
});

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

describe("mcp tools/list", () => {
  test("every tool name matches the MCP name pattern ^[a-zA-Z0-9_-]{1,64}$", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.name).toMatch(TOOL_NAME_PATTERN);
    }
  });

  test("exposes workflows with input schemas", async () => {
    await suite.seedWorkflow({
      name: "list probe",
      slug: "list-probe",
      description: "a tiny probe",
      input_schema: {
        type: "object",
        properties: { who: { type: "string" } },
        required: ["who"],
      },
      steps: [
        {
          kind: "transform",
          id: "echo",
          expression: "$input",
        },
      ],
    });

    const client = await suite.connect();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("wf_list-probe");
    const tool = result.tools.find((t) => t.name === "wf_list-probe");
    expect(tool?.description).toContain("a tiny probe");
    expect(tool?.description).toContain("Run the saved workflow");
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: { who: { type: "string" } },
      required: ["who"],
    });
  });

  test("C2: no-argument wf_ tool inputSchema is EMPTY_OBJECT_SCHEMA with additionalProperties:false", async () => {
    await suite.seedWorkflow({
      name: "no args probe",
      slug: "no-args-probe",
      steps: [{ kind: "transform", id: "noop", expression: "$input" }],
    });
    const client = await suite.connect();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "wf_no-args-probe");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  test("P2: wf_ tool carries all four MCP-standard annotations on the wire", async () => {
    await suite.seedWorkflow({
      name: "annotations probe",
      slug: "annotations-probe",
      steps: [{ kind: "transform", id: "noop", expression: "$input" }],
    });
    const client = await suite.connect();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "wf_annotations-probe");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(true);
    expect(tool?.annotations?.idempotentHint).toBe(false);
    expect(tool?.annotations?.openWorldHint).toBe(true);
  });

  test("versioned workflow effects reach the MCP wire without weakening the default", async () => {
    await suite.seedWorkflow({
      name: "read effect probe",
      slug: "read-effect-probe",
      tool_effect: "read",
      steps: [{ kind: "transform", id: "noop", expression: "$input" }],
    });
    await suite.seedWorkflow({
      name: "reversible effect probe",
      slug: "reversible-effect-probe",
      tool_effect: "reversible_write",
      steps: [{ kind: "transform", id: "noop", expression: "$input" }],
    });
    const client = await suite.connect();
    const byName = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    expect(byName.get("wf_read-effect-probe")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName.get("wf_reversible-effect-probe")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  test("P0: write tools advertise readOnlyHint:false and never destructiveHint:false", async () => {
    const { plaintext: adminKey } = await suite.issueApiKey(["*", "mcp:admin"]);
    const client = await suite.connectWithApiKey(adminKey);
    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
    for (const name of [
      "call_connector",
      "authenticate",
      "run_workflow",
      "subkit_update_setting",
    ]) {
      const a = byName.get(name)?.annotations;
      if (!a) continue;
      expect(a.readOnlyHint).toBe(false);
      expect(a.destructiveHint).toBe(true);
    }
    const cc = byName.get("call_connector");
    if (cc) {
      expect(cc.title).not.toContain("_");
      expect(cc.title).not.toBe(cc.name);
    }
  });

  test("probe_connector advertises readOnlyHint:false + destructiveHint:true", async () => {
    const { plaintext: adminKey } = await suite.issueApiKey(["*", "mcp:admin"]);
    const client = await suite.connectWithApiKey(adminKey);
    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
    const tool = byName.get("probe_connector");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  test("probe_connector_draft's annotation builder output stays readOnlyHint:false + destructiveHint:true", () => {
    const annotations = buildToolAnnotations("draft_write", "probe_connector_draft");
    expect(annotations.readOnlyHint).toBe(false);
    expect(annotations.destructiveHint).toBe(true);
  });

  test("P2: conversation_* tools have taskSupport=optional; wf_* tools have taskSupport=forbidden", async () => {
    await suite.seedWorkflow({
      name: "task support probe",
      slug: "task-support-probe",
      steps: [{ kind: "transform", id: "noop", expression: "$input" }],
    });
    const { plaintext: adminKey } = await suite.issueApiKey(["*", "mcp:admin"]);
    const client = await suite.connectWithApiKey(adminKey);
    const result = await client.listTools();
    const convTool = result.tools.find((t) => t.name === "conversation_start");
    const wfTool = result.tools.find((t) => t.name === "wf_task-support-probe");
    expect(convTool).toBeDefined();
    expect(wfTool).toBeDefined();
    expect(
      (convTool as Record<string, unknown> & { execution?: { taskSupport?: string } })?.execution
        ?.taskSupport,
    ).toBe("optional");
    expect(
      (wfTool as Record<string, unknown> & { execution?: { taskSupport?: string } })?.execution
        ?.taskSupport,
    ).toBe("forbidden");
  });

  test("P2: wf_ tool with declared output_schema echoes it in tools/list", async () => {
    const OUTPUT_SCHEMA = {
      type: "object" as const,
      properties: { score: { type: "number" } },
    };
    await suite.seedWorkflow({
      name: "output schema echo",
      slug: "output-schema-echo",
      output_schema: OUTPUT_SCHEMA,
      steps: [
        {
          kind: "transform",
          id: "out",
          expression: "return { score: 1 };",
          language: "javascript",
        },
      ],
    });
    const client = await suite.connect();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "wf_output-schema-echo");
    expect(tool).toBeDefined();
    const echoed = (tool as Record<string, unknown>)?.outputSchema as { type?: string } | undefined;
    expect(echoed?.type).toBe("object");
  });

  test("authoring mode advertises the previously-trimmed long tail by name", async () => {
    const { plaintext: authoringKey } = await suite.issueApiKey(["*", "mcp:authoring"]);
    const client = await suite.connectWithApiKey(authoringKey);
    const result = await client.listTools();
    const names = new Set(result.tools.map((t) => t.name));
    expect(names.has("call_connector")).toBe(true);
    expect(names.has("dry_run_transform")).toBe(true);
    expect(names.has("list_skills")).toBe(true);
    expect(names.has("list_knowledge_sources")).toBe(true);
    expect(names.has("find_tool")).toBe(false);
  });

  test("rejects malformed cursors", async () => {
    for (let i = 0; i < 101; i++) {
      await suite.seedWorkflow({
        name: `Paged Tool ${i}`,
        slug: `paged-tool-${i}`,
        steps: [],
      });
    }

    const client = await suite.connect();
    await expect(client.listTools({ cursor: "not-base64-json" })).rejects.toThrow(
      /Invalid pagination cursor for tools\/list/,
    );
  });
});
